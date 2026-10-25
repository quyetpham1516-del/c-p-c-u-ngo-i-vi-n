#!/bin/bash
# Cài máy chủ chỉ đường OSRM (miễn phí, dữ liệu OpenStreetMap Việt Nam) trên Mac, chạy ở 127.0.0.1:5001.
# Lần đầu tải ~300 MB dữ liệu và xử lý 10–30 phút; cần khoảng 3 GB đĩa trống. Cập nhật bản đồ: xóa ~/medone-tools/osrm/vietnam.osrm* rồi chạy lại.
#   bash deploy/mac/cai-osrm.sh [hệ số giao thông, mặc định 1.3]
source "$(dirname "$0")/chung.sh"
FACTOR=${1:-1.3}
D="$T/osrm"; mkdir -p "$D"; cd "$D"
[ -f package.json ] || echo '{"name":"medone-osrm","private":true}' > package.json
[ -d node_modules/@project-osrm/osrm ] || npm install --no-audit --no-fund @project-osrm/osrm@26.10.0
B=$(dirname "$(ls "$D"/node_modules/@project-osrm/osrm/lib/binding*/osrm-routed 2>/dev/null | head -1)")
[ -x "$B/osrm-extract" ] || { echo "Gói OSRM không có bản dựng sẵn cho máy này (thiếu osrm-extract)"; exit 1; }
PROFILE="$D/node_modules/@project-osrm/osrm/profiles/car.lua"

if [ ! -f vietnam.osrm.mldgr ]; then
  echo "Tải bản đồ Việt Nam (Geofabrik)…"
  curl -fL --progress-bar -o vietnam.osm.pbf.tmp https://download.geofabrik.de/asia/vietnam-latest.osm.pbf && mv vietnam.osm.pbf.tmp vietnam.osm.pbf
  echo "Xử lý dữ liệu đường (có thể mất 10–30 phút)…"
  "$B/osrm-extract" -p "$PROFILE" -t 2 vietnam.osm.pbf
  "$B/osrm-partition" vietnam.osrm
  "$B/osrm-customize" vietnam.osrm
  rm -f vietnam.osm.pbf
fi

RUN="$D/chay.sh"
printf '#!/bin/bash\nexec "%s/osrm-routed" --algorithm mld --ip 127.0.0.1 --port 5001 "%s/vietnam.osrm"\n' "$B" "$D" > "$RUN"
chmod 700 "$RUN"
start_bg "$RUN" "$T/logs/osrm.log" "http://127.0.0.1:5001/route/v1/driving/106.70,10.78;106.66,10.76?overview=false"
wait_http "http://127.0.0.1:5001/route/v1/driving/106.70,10.78;106.66,10.76?overview=false" 120 || { echo "OSRM chưa lên, xem $T/logs/osrm.log"; exit 1; }
echo "Thử tuyến Nhà thờ Đức Bà → Chợ Rẫy:"
curl -fs "http://127.0.0.1:5001/route/v1/driving/106.6990,10.7798;106.6597,10.7578?overview=false" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).routes[0];console.log(`  ${(r.distance/1000).toFixed(1)} km, ${(r.duration/60).toFixed(1)} phút (chưa nhân hệ số giao thông)`)})'
set_env MEDONE_OSRM_URL http://127.0.0.1:5001
set_env MEDONE_OSRM_FACTOR "$FACTOR"
write_agent vn.medone.osrm "$RUN" "$T/logs/osrm.log" "$D/vietnam.osrm"
echo "Đã đặt MEDONE_OSRM_URL và MEDONE_OSRM_FACTOR=$FACTOR trong .env. Khởi động lại API để dùng."
