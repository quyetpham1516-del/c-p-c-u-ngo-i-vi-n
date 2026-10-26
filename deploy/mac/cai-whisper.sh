#!/bin/bash
# Cài máy chép lời whisper.cpp (chạy trên chip Apple bằng Metal) cho Medone, chạy ở 127.0.0.1:8178.
# Mô hình mặc định large-v3-turbo (bản nén q5_0, ~550 MB, dùng ~1 GB RAM). Cần Xcode Command Line Tools.
#   bash deploy/mac/cai-whisper.sh [tên mô hình, mặc định large-v3-turbo-q5_0]
source "$(dirname "$0")/chung.sh"
MODEL=${1:-large-v3-turbo-q5_0}
D="$T/whisper"; mkdir -p "$D"; cd "$D"
xcode-select -p >/dev/null 2>&1 || { echo "Thiếu Xcode Command Line Tools: chạy xcode-select --install"; exit 1; }

# CMake trong môi trường Python riêng (không cần Homebrew)
if [ ! -x "$T/venv/bin/cmake" ]; then
  python3 -m venv "$T/venv" && "$T/venv/bin/pip" install -q --disable-pip-version-check cmake
fi

if [ ! -x "$D/src/build/bin/whisper-server" ]; then
  # grep -m1 đóng ống sớm làm curl báo lỗi: không để pipefail dừng cả bộ cài
  TAG=$(curl -fs https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest | grep -m1 '"tag_name"' | cut -d'"' -f4 || true)
  [ -n "$TAG" ] || TAG=v1.8.2
  echo "Tải whisper.cpp $TAG…"
  curl -fL --progress-bar -o src.tar.gz "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/$TAG.tar.gz"
  rm -rf src && mkdir src && tar -xzf src.tar.gz -C src --strip-components=1 && rm -f src.tar.gz
  echo "Dựng whisper-server (vài phút)…"
  build() {
    "$T/venv/bin/cmake" -S src -B src/build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF >/dev/null &&
    "$T/venv/bin/cmake" --build src/build --config Release -j 4 --target whisper-server >/dev/null
  }
  if ! build; then
    # Command Line Tools cũ hơn SDK mặc định (lỗi "tapi error: malformed file"): dựng lại với SDK mới nhất cùng đời Command Line Tools
    SDKS=/Library/Developer/CommandLineTools/SDKs
    CLT_MAJOR=$(pkgutil --pkg-info=com.apple.pkg.CLTools_Executables 2>/dev/null | awk '/version:/ {split($2,a,"."); print a[1]}' || true)
    SDK=$(ls -d "$SDKS"/MacOSX"${CLT_MAJOR}".*.sdk 2>/dev/null | grep -v 'MacOSX.sdk' | sort -V | tail -1 || true)
    [ -n "$SDK" ] || { echo "Dựng whisper.cpp lỗi; cập nhật Command Line Tools (softwareupdate --list) rồi chạy lại"; exit 1; }
    echo "Dựng lại với $(basename "$SDK") cho khớp Command Line Tools…"
    rm -rf src/build
    SDKROOT="$SDK" build || { echo "Dựng whisper.cpp lỗi; cập nhật Command Line Tools rồi chạy lại"; exit 1; }
  fi
fi

if [ ! -s "models/ggml-$MODEL.bin" ]; then
  mkdir -p models
  echo "Tải mô hình $MODEL…"
  curl -fL --progress-bar -o "models/ggml-$MODEL.bin.tmp" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
  mv "models/ggml-$MODEL.bin.tmp" "models/ggml-$MODEL.bin"
fi

RUN="$D/chay.sh"
printf '#!/bin/bash\nexec "%s/src/build/bin/whisper-server" -m "%s/models/ggml-%s.bin" --host 127.0.0.1 --port 8178 --inference-path /v1/audio/transcriptions -l vi -t 4\n' "$D" "$D" "$MODEL" > "$RUN"
chmod 700 "$RUN"
pkill -f "$D/src/build/bin/whisper-server" || true
start_bg "$RUN" "$T/logs/whisper.log"
wait_http "http://127.0.0.1:8178/" 120 || { echo "whisper-server chưa lên, xem $T/logs/whisper.log"; exit 1; }

# Thử bằng giọng đọc tiếng Việt có sẵn của macOS (nếu máy có giọng Linh)
if say -v '?' | grep -q '^Linh'; then
  say -v Linh -o "$D/thu.wav" --data-format=LEI16@8000 "Alo, cấp cứu, ông tôi bị đau ngực và khó thở, địa chỉ số mười hai Lê Lợi"
  echo "Thử chép lời đoạn mẫu (giọng máy, 8 kHz như điện thoại):"
  curl -fs -F file=@"$D/thu.wav" -F response_format=json -F language=vi http://127.0.0.1:8178/v1/audio/transcriptions
  echo
fi
set_env MEDONE_ASR_URL http://127.0.0.1:8178/v1
write_agent vn.medone.whisper "$RUN" "$T/logs/whisper.log" "$D/models/"
echo "Đã đặt MEDONE_ASR_URL trong .env. Khởi động lại API để bắt đầu chép lời các cuộc gọi có ghi âm."
