# Hàm dùng chung cho các bộ cài trên máy Mac (source từ các tệp cai-*.sh). Không in mật khẩu ra màn hình.
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
T=${MEDONE_TOOLS:-$HOME/medone-tools}
mkdir -p "$T/logs" "$T/launchagents"
ENV_FILE="$REPO/.env"

# Đặt hoặc thay một biến trong .env (giữ nguyên phần còn lại)
set_env() {
  local k=$1 v=$2
  touch "$ENV_FILE"
  if grep -q "^$k=" "$ENV_FILE"; then
    local tmp; tmp=$(mktemp)
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$ENV_FILE" > "$tmp" && cat "$tmp" > "$ENV_FILE" && rm -f "$tmp"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"
  fi
}

# Chờ một địa chỉ http trả lời (tối đa $2 giây)
wait_http() {
  local url=$1 secs=${2:-120} i=0
  until curl -fs -o /dev/null "$url"; do
    i=$((i + 2)); [ $i -ge "$secs" ] && return 1; sleep 2
  done
}

# Tạo tệp LaunchAgent để dịch vụ tự chạy khi đăng nhập máy (người dùng tự chép vào ~/Library/LaunchAgents)
write_agent() {
  local label=$1 script=$2 log=$3 pattern=${4:-$2}
  cat > "$T/launchagents/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$script</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict></plist>
PLIST
  echo "Để $label tự chạy khi mở máy, dán vào Terminal:"
  echo "  pkill -f '$pattern' ; sleep 2 ; cp '$T/launchagents/$label.plist' ~/Library/LaunchAgents/ && launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/$label.plist"
}

# Chạy nền ngay (trước khi có LaunchAgent); địa chỉ kiểm tra đã trả lời thì coi như đang chạy
start_bg() {
  local script=$1 log=$2 url=${3:-}
  if [ -n "$url" ] && curl -fs -o /dev/null "$url"; then return 0; fi
  nohup /bin/bash "$script" >> "$log" 2>&1 &
}
