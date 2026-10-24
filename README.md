# Medone – Phần mềm điều phối cấp cứu ngoại viện

Phần mềm cho **Dịch vụ Chuyển viện – Cấp cứu ngoại viện Medone**, xây theo bản MVP ở mục 12.5 của
*Kế hoạch thành lập Trung tâm Cấp cứu Ngoại viện và Phần mềm EOC–Paramedic*. Biểu tượng là Ngôi sao sự sống
(Star of Life), biểu tượng chung của cấp cứu ngoại viện.

> Đây là bản dựng đầu tiên để chạy thử và trình diễn với điều phối viên, kíp. Bộ câu hỏi phân loại là **bản nháp**,
> Hội đồng Chuyên môn phải duyệt trước khi dùng cho người bệnh thật (mục 5.4, 5.11, 12.7).

## Có gì trong bản này

| Phần | Nội dung | Mục kế hoạch |
|---|---|---|
| Tiếp nhận cuộc gọi | Hàng chờ cuộc gọi (đường 1800 và đường nóng 115), thời gian chờ, nhận cuộc gọi sinh Mã ca tại T0, chặn hai người nhận trùng, danh sách gọi lại cuộc bỏ dở, nhập tay ca từ 115 | 5.1, 12.4, 12.7 |
| Phân loại tự động | Bộ câu hỏi CBD 16 nhóm, câu sống còn hỏi trước; không tỉnh + không thở → P1 ngừng tim ngay, hướng dẫn ép tim; đột quỵ trong cửa sổ → xe đột quỵ có CT; "Không rõ" tính như "Có" để tránh phân loại thiếu | 5.4, 5.11 |
| Xác nhận bắt buộc | Không giao được xe khi chưa có người bấm xác nhận mã và loại xe; đổi mã phải chọn lý do; lưu cả mã máy đề xuất và mã cuối | 5.11 |
| Giao xe | Gợi ý xe theo năng lực và khoảng cách; P1 có ALS xa > 12 phút thì khuyên gửi đồng thời BLS; ECMO/xe vận chuyển chỉ giờ hành chính; rút xe từ ca P3–P4 cho ca P1 (có lý do); báo trước bệnh viện; chuyển ca sang 115; thông báo ca P1–P2 sang 115 | 5.5, 5.6, 12.7 |
| Bảng đội xe thời gian thực | Mỗi xe một dòng: trạng thái S1–S9, thời gian ở trạng thái, kíp, ca đang làm, dự kiến rảnh lúc mấy (kèm khoảng dao động), cơ số; bản đồ; cảnh báo P1 chờ > 60 giây, P2 > 3 phút, ≥ 3 ca P2 chờ | 5.6, 5.12 |
| Ứng dụng kíp | Đăng nhập ca trên xe, nhận lệnh, nút trạng thái lớn ghi mốc T5–T14, dẫn đường, gửi GPS (5 giây/lần khi làm nhiệm vụ), báo "rảnh trong 5 phút", cập nhật cơ số | 5.1, 6.1 |
| ePCR | Bộ dữ liệu theo mẫu 115 TP.HCM: ABCDE, SAMPLE, khám, điện tim, sinh hiệu, can thiệp, thuốc (bắt buộc số lô), chẩn đoán ICD-10, kết cục, bàn giao, sơ sinh, đối tượng thu phí; **chạy khi mất mạng** (lưu IndexedDB, tự đồng bộ, gửi lại không tạo bản trùng); ký phiếu kiểm tra trường bắt buộc; sửa sau khi ký phải "bổ sung" có lý do | 8.6, 12.4, 12.5 |
| Một người bệnh – một bệnh án | Khóa CCCD/số định danh/hộ chiếu, **mã hóa AES-256-GCM**, tìm bằng HMAC, màn hình chỉ hiện 4 số cuối; kiểm tra trùng trước khi cấp Số BA; nhiều phiếu chuyển viện (Năm-Số thứ tự) trên một bệnh án; bệnh án tạm cho người chưa rõ danh tính, gộp có duyệt và tách lại được | 8.6 |
| Truy xuất ca và lưu vết | Mọi thao tác ghi vào nhật ký chỉ ghi thêm (cơ sở dữ liệu chặn sửa/xóa), chuỗi băm SHA-256 theo từng ca; màn hình dựng lại ca và báo ngay nếu chuỗi bị phá; lượt xem cũng bị ghi | 6.2, 6.3, 6.4 |
| 16 mốc thời gian | T0–T15 tự ghi từ tổng đài, CAD, nút trên máy tính bảng, ePCR; giữ giá trị đầu tiên | 5.2 |
| In phiếu | Phiếu chuyển viện in được, có Số BA, Số chuyển viện, mốc thời gian, chữ ký hai bên | 8.5, 8.6 |

## Chưa có trong bản này (theo đúng lộ trình)

Nối tổng đài SIP thật (đã có webhook `/api/telephony/ring` và `/abandon` chờ nối), ghi âm, ASR; bản đồ Việt Nam có giao thông
(đang dùng OpenStreetMap và ước tính theo khoảng cách); chữ ký số CA; FHIR sang bệnh viện; kho – cơ số; ứng dụng Android gốc
(bản này là ứng dụng web cài được, chạy offline); đăng nhập Keycloak/MFA; vùng bị hở trên bản đồ. Xem mục 12.5, 12.7 của kế hoạch.

## Chạy thử

Cần Node.js 22 và PostgreSQL 16.

```bash
npm install
createdb medone                       # hoặc dùng docker compose ở dưới
npm run seed                          # 6 xe, 3 trạm, 10 vị trí EOC, kíp mẫu
npm run build                         # dựng giao diện
npm start                             # http://localhost:8080
```

Hoặc: `docker compose up --build` rồi `docker compose exec app npm run seed`.

Tài khoản thử (mật khẩu `medone123`, chỉ dùng thử): `dpv01`–`dpv05` tiếp nhận cuộc gọi, `dpv06`–`dpv10` điều phối viên,
`truongca`, `qlcl`, `admin`, kíp `bs.als`, `dd.als`, `ys.bls`, `bs.msu`, `dd.vc`.

Thử một ca: đăng nhập `bs.als` trên máy tính bảng/điện thoại và bắt đầu ca trên xe MD-ALS-01; đăng nhập `dpv01` trên máy khác,
bấm **Giả lập cuộc gọi** → **Nhận** → nhập địa chỉ, bấm bản đồ → trả lời câu hỏi → **Xác nhận**; đăng nhập `dpv06` để **Giao** xe.

Phát triển: `npm run dev:server` và `npm run dev:web` (Vite ở cổng 5173, tự chuyển tiếp API).

## Kiểm thử

```bash
npm test                              # 52 kiểm thử: phân loại, mã hóa, chuỗi băm, gợi ý xe, trọn luồng một ca
npm run load -w server -- 100 20      # kiểm thử tải
```

Kết quả kiểm thử tải trên máy làm việc (1 tiến trình máy chủ, PostgreSQL cùng máy):

| Kịch bản | Xử lý hết hàng chờ | API p95 | Đồng bộ màn hình p95 | Mã ca trùng | Chuỗi băm sai |
|---|---|---|---|---|---|
| 50 cuộc gọi, 10 vị trí (yêu cầu) | 1,5 giây | 92 ms | 9 ms | 0 | 0 |
| 100 cuộc gọi, 20 vị trí (gấp đôi) | 5,7 giây | 89 ms | 15 ms | 0 | 0 |

Mục tiêu mục 12.4 là màn hình EOC phản hồi dưới 1 giây. Con số này chưa gồm tổng đài, ghi âm và mạng thật; cần đo lại trên hạ tầng
triển khai.

## Cấu trúc

```
server/   Node.js 22 + Fastify + PostgreSQL (TypeScript)
  migrations/        lược đồ dữ liệu
  src/triage/        bộ câu hỏi và hàm tính mã (hàm thuần, có phiên bản)
  src/domain.ts      mốc thời gian, trạng thái xe, giao xe, xác nhận
  src/audit.ts       nhật ký chỉ ghi thêm + chuỗi băm
  src/routes/        API
  test/  load/
web/      React + TypeScript + Vite, ứng dụng web cài được (PWA)
```

**Vì sao không dùng Java/Spring như mục 12.2 đề xuất:** để có bản chạy được sớm với một ngôn ngữ cho cả máy chủ, màn hình EOC và
ứng dụng kíp offline. Kiến trúc giữ đúng nguyên tắc của kế hoạch (PostgreSQL, bảng sự kiện chỉ ghi thêm, outbox thay Kafka,
WebSocket, phần sống còn tách khỏi hành chính); đội phát triển chính thức có thể giữ hoặc viết lại phần máy chủ sau giai đoạn 0.

## Biến môi trường khi triển khai

`DATABASE_URL`, `MEDONE_JWT_SECRET`, `MEDONE_DATA_KEY` (mã hóa số định danh), `MEDONE_LOOKUP_KEY` (tìm kiếm),
`MEDONE_TELEPHONY_KEY` (webhook tổng đài). Ở chế độ `NODE_ENV=production` máy chủ từ chối chạy nếu thiếu các khóa này.
**Mất `MEDONE_DATA_KEY` là mất khả năng đọc số CCCD đã lưu**: cất khóa trong kho khóa (HSM/KMS) và có bản sao.
