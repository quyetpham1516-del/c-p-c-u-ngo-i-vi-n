#!/bin/bash
# Cài Keycloak (đăng nhập một lần) cho Medone trên Mac, không cần Homebrew hay Docker: Java 21 và Keycloak nằm trong ~/medone-tools.
# Keycloak chạy ở 127.0.0.1:8180/auth và đi chung cổng HTTPS của Medone (https://<máy>:3443/auth), nên không phải tin thêm chứng chỉ nào.
#   MEDONE_PUBLIC_URL=https://192.168.1.54:3443 [MEDONE_KEYCLOAK_INITIAL_PASSWORD=<mật khẩu tạm>] bash deploy/mac/cai-keycloak.sh
# Đổi IP máy chủ: chạy lại lệnh với địa chỉ mới.
source "$(dirname "$0")/chung.sh"
KC_VER=26.0.7
: "${MEDONE_PUBLIC_URL:?Đặt MEDONE_PUBLIC_URL, ví dụ https://192.168.1.54:3443 (địa chỉ mọi người mở Medone)}"
PUB=${MEDONE_PUBLIC_URL%/}
[ "$(uname -m)" = arm64 ] && A=aarch64 || A=x64

if [ ! -x "$T/jdk/Contents/Home/bin/java" ]; then
  echo "Tải Java 21 (Eclipse Temurin)…"
  curl -fL --progress-bar -o "$T/jdk.tar.gz" "https://api.adoptium.net/v3/binary/latest/21/ga/mac/$A/jdk/hotspot/normal/eclipse"
  rm -rf "$T/jdk.tmp" && mkdir "$T/jdk.tmp" && tar -xzf "$T/jdk.tar.gz" -C "$T/jdk.tmp" --strip-components=1
  rm -rf "$T/jdk" && mv "$T/jdk.tmp" "$T/jdk" && rm -f "$T/jdk.tar.gz"
fi
"$T/jdk/Contents/Home/bin/java" -version 2>&1 | head -1

if [ ! -x "$T/keycloak/bin/kc.sh" ]; then
  echo "Tải Keycloak $KC_VER…"
  curl -fL --progress-bar -o "$T/kc.zip" "https://github.com/keycloak/keycloak/releases/download/$KC_VER/keycloak-$KC_VER.zip"
  rm -rf "$T/kc.tmp" && mkdir "$T/kc.tmp" && unzip -q "$T/kc.zip" -d "$T/kc.tmp"
  rm -rf "$T/keycloak" && mv "$T/kc.tmp/keycloak-$KC_VER" "$T/keycloak" && rm -rf "$T/kc.tmp" "$T/kc.zip"
fi

# Mật khẩu quản trị Keycloak: sinh một lần, chỉ chủ máy đọc được
if [ ! -s "$T/keycloak-admin.txt" ]; then
  (umask 077; openssl rand -base64 24 | tr -d '/+=\n' > "$T/keycloak-admin.txt")
  echo "Đã tạo mật khẩu quản trị Keycloak trong $T/keycloak-admin.txt (không in ra đây)"
fi

RUN="$T/keycloak/chay.sh"
cat > "$RUN" <<RUNSH
#!/bin/bash
export JAVA_HOME="$T/jdk/Contents/Home"
# Máy 8 GB: giới hạn bộ nhớ Keycloak (mặc định Java lấy tới 70% RAM)
export JAVA_OPTS_KC_HEAP="-Xms128m -Xmx768m"
export KC_BOOTSTRAP_ADMIN_USERNAME=admin
export KC_BOOTSTRAP_ADMIN_PASSWORD="\$(cat "$T/keycloak-admin.txt")"
exec "$T/keycloak/bin/kc.sh" start-dev --http-host=127.0.0.1 --http-port=8180 --http-relative-path=/auth \\
  --hostname="$PUB/auth" --hostname-backchannel-dynamic=true --proxy-headers=xforwarded
RUNSH
chmod 700 "$RUN"

# Địa chỉ đổi thì khởi động lại để nhận hostname mới
if curl -fs -o /dev/null "http://127.0.0.1:8180/auth/realms/master" && ! curl -fs "http://127.0.0.1:8180/auth/realms/master/.well-known/openid-configuration" | grep -q "\"issuer\":\"$PUB/auth/"; then
  pkill -f "$T/keycloak/" || true; sleep 3
fi
start_bg "$RUN" "$T/logs/keycloak.log" "http://127.0.0.1:8180/auth/realms/master"
echo "Chờ Keycloak khởi động (lần đầu mất 1–2 phút)…"
wait_http "http://127.0.0.1:8180/auth/realms/master" 240 || { echo "Keycloak chưa lên, xem $T/logs/keycloak.log"; exit 1; }

(cd "$REPO/server" && KC_BOOTSTRAP_ADMIN_PASSWORD="$(cat "$T/keycloak-admin.txt")" MEDONE_PUBLIC_URL="$PUB" npm run -s keycloak:sync)
write_agent vn.medone.keycloak "$RUN" "$T/logs/keycloak.log" "$T/keycloak/"
echo "Xong. Khởi động lại API và cổng HTTPS của Medone để bật nút Đăng nhập một lần."
echo "Trang quản trị Keycloak: $PUB/auth/admin (tài khoản admin, mật khẩu trong $T/keycloak-admin.txt)"
