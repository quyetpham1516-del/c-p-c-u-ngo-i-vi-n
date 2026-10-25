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
| Chỉ giao xe rảnh, tự báo xe gần nhất | Xe đang bận không giao được; nút **Tự động báo xe rảnh gần nhất** giao ngay xe phù hợp trong bán kính `MEDONE_AUTO_DISPATCH_KM` (mặc định 5 km), máy tính bảng của kíp đổ chuông, rung cho tới khi bấm **Xác nhận lệnh**; xe gần nhất xa hơn bán kính thì không tự giao mà báo điều phối xác nhận | 5.5 |
| Danh mục bệnh viện | 154 cơ sở KCB TP.HCM theo danh sách BHXH quý 3/2022 (mã KCB, địa chỉ, nhóm) + 11 bệnh viện tuyến cuối, mỗi nơi có danh sách khoa nhận bệnh; chọn ở "Kính gửi", báo trước bệnh viện và "Đơn vị nhận bệnh" (tự điền *Khoa – Bệnh viện*) | 8.6 |
| ICD-10 Bộ Y tế | 13.186 mã theo danh mục Bộ Y tế; gõ mã (kể cả thiếu dấu chấm, mã có †) là hiện tên bệnh và tự điền chẩn đoán | 8.6 |
| Kho thuốc theo số lô | Nhập kho tại từng điểm (số lô, hạn dùng, số lượng); trong phiếu chọn thuốc là tự lấy số lô hết hạn sớm nhất; ký phiếu thì trừ kho đúng lô, không đủ thì không cho ký; kiểm kê điều chỉnh có lý do | 8.6 |
| Kho đầy đủ (QL-13, QLCL-16) | Kho điểm → cơ số trên xe → người bệnh; cơ số chuẩn theo loại xe, kíp bấm **Bù cơ số** lấy từ kho điểm theo lô hết hạn trước; phiếu cấp xe, trả kho, điều chuyển, kiểm kê, hủy; kiểm kê lệch và hủy thuốc phải **người khác duyệt**; thuốc gây nghiện/hướng thần phải ghi người chứng kiến; cảnh báo hết hạn, sắp hết hạn, dưới định mức, xe thiếu cơ số; đề xuất đặt hàng tuần | 7.5 |
| Trang thiết bị và dụng cụ (QLCL-15) | Thiết bị theo số seri: bảo dưỡng, kiểm định, hiệu chuẩn (tự tính hạn kế tiếp), báo hỏng, điều chuyển, thanh lý; **xe thiếu, hỏng hoặc quá hạn kiểm định thiết bị bắt buộc không được gợi ý và không giao được** (trưởng ca cho đi phải ghi lý do); bộ dụng cụ dùng lại: dùng → lô tiệt khuẩn (chỉ thị đạt/không đạt) → sẵn sàng có hạn vô khuẩn | 7.5 |
| Kiểm soát nhiễm khuẩn (QLCL-10) | Điều phối hoặc kíp đánh dấu nguy cơ lây nhiễm (tiếp xúc, giọt bắn, không khí); sau ca xe phải **ký phiếu khử khuẩn đủ mức** (thường quy, tăng cường, toàn diện, kèm hóa chất và thời gian tiếp xúc) mới báo sẵn sàng được; quan sát vệ sinh tay 5 thời điểm, phơi nhiễm nghề nghiệp (bảo mật, theo dõi dự phòng), tiêm chủng nhân viên, chất thải y tế | 7.5 |
| Sự cố y khoa (QLCL-03, TT 43/2018) | Mọi nhân viên báo sự cố ở **Báo sự cố**, được báo ẩn danh; QLCL phân loại NC0–NC3, phân tích nguyên nhân gốc, giao việc khắc phục có hạn và bằng chứng; NC3 phải ghi đã báo cơ quan quản lý và do Ban Giám đốc đóng; hệ thống tự gợi ý sự cố từ dữ liệu (P1 lăn bánh chậm, tới nơi > 15 phút, phiếu bổ sung, giao xe thiếu thiết bị, lô tiệt khuẩn không đạt) | 7.5 |
| Khiếu nại và hài lòng (QLCL-07, 08) | Tiếp nhận khiếu nại theo ca (hạn trả lời 24/48 giờ); sau ca có phục vụ, hệ thống xếp hàng tin nhắn khảo sát với đường dẫn công khai `/khao-sat/<mã>` (không cần đăng nhập, hết hạn 30 ngày); điểm ≤ 2 tự tạo khiếu nại để gọi lại. Tin nhắn nằm ở **Tin nhắn chờ gửi** cho tới khi nối nhà cung cấp SMS/Zalo | 7.5 |
| Nhân sự | Mỗi tài khoản có hồ sơ nhân viên (tự tạo), thêm được nhân viên chưa có tài khoản; giấy tờ hành nghề (GPHN, bằng lái, BLS/ACLS...) có hạn; **GPHN/bằng lái hết hạn hoặc bị đình chỉ, đang nghỉ phép đã duyệt thì không nhận ca trên xe được**; đào tạo và số tiết cập nhật kiến thức 5 năm; lịch trực tuần (chặn xếp ca liền sau trực đêm/24 giờ trừ khi ghi lý do); đơn nghỉ phép có duyệt; chấm công văn phòng; bảng công tháng (giờ theo lịch, giờ thực tế trên xe) xuất CSV | 7.5 |
| Chấm công QR tại trạm | Tab **Chấm công QR** ở Nhân sự: phòng Nhân sự cấp máy chấm công cho từng trạm (đường dẫn chỉ hiện một lần, mở trên máy tính bảng đặt ở trạm, trang `/may-cham-cong`). Máy hiện mã QR **đổi mỗi 30 giây**; nhân viên quét bằng camera điện thoại đã đăng nhập, lần đầu là vào ca, lần sau là ra ca. Máy chủ chỉ nhận mã còn hạn (khoảng 1 phút) và vị trí GPS trong bán kính trạm (mặc định 300 m, chỉnh được); ở xa trạm thì bị từ chối và lưu vết; vị trí sai số lớn, không có vị trí (khi trạm cho phép), ra ở trạm khác, bấm tay trên web thì được đánh dấu để nhân sự xem lại. Mất máy tính bảng: bấm Thu hồi hoặc Cấp lại. Điện thoại cần mở trang qua HTTPS mới lấy được vị trí | 7.5 |
| Liên thông bệnh viện nhận và người nhà | Khung **Liên thông** ở màn hình ca (EOC): gửi người nhà đường dẫn **theo dõi xe** (xe nào, dự kiến tới sau bao lâu, đã tới, đang chuyển đi bệnh viện nào; không có thông tin bệnh án); điều phối gửi bệnh viện đã báo trước đường dẫn **báo trước** (mức ưu tiên, tuổi, giới, viết tắt tên, lý do, chẩn đoán sơ bộ, sinh hiệu mới nhất kíp ghi, giờ dự kiến tới), bệnh viện bấm **Sẵn sàng tiếp nhận** hoặc **Không nhận được** (ghi lý do) và điều phối thấy ngay. Đường dẫn hết hạn sau 6 giờ (bệnh viện) hoặc 3 giờ (người nhà), hết hiệu lực khi ca kết thúc, thu hồi được; mã chỉ hiện một lần, máy chủ lưu mã băm. Tin nhắn vào hàng đợi, gửi tự động khi cấu hình cổng SMS. Người ngoài mạng nội bộ mở được khi đặt `NEXT_PUBLIC_VERIFY_URL` là địa chỉ công khai | 7.5 |
| Bảng lương | Trang **Bảng lương** (nhân sự, kế toán, Ban Giám đốc): hồ sơ lương từng người (lương tháng hoặc theo ca, lương đóng BHXH, phụ cấp cố định có/không tính thuế, đóng BH, người phụ thuộc); **tính lương tháng** từ lịch trực (phụ cấp ca đêm, trực 24 giờ), số chuyến kíp đã ký phiếu (phụ cấp chuyến), đơn nghỉ không lương đã duyệt; BHXH/BHYT/BHTN (trần 20 lần lương cơ sở / lương tối thiểu vùng), KPCĐ, thuế TNCN lũy tiến sau giảm trừ gia cảnh hoặc khấu trừ 10% (thử việc, cộng tác viên); điều chỉnh thưởng, truy thu, trừ tạm ứng; Ban Giám đốc duyệt (người lập không tự duyệt), kế toán ghi đã chi; xuất Excel; nhân viên xem phiếu lương ở trang Cá nhân. Tham số mặc định là bản nháp, kế toán đối chiếu văn bản hiện hành | 7.5 |
| Bộ phận, trưởng nhóm và báo cáo theo cấp | Trang **Bộ phận**: sơ đồ tổ chức (Ban Giám đốc → EOC, Chuyên môn, Hậu cần, QLCL, Hành chính – Nhân sự, Tài chính → các nhóm như nhóm tiếp nhận, nhóm điều phối, dược – kho, thiết bị – xe, KSNK); quản trị, Ban Giám đốc, nhân sự thêm/sửa bộ phận, xếp thành viên và **chỉ định trưởng nhóm** (có thể nhiều người, ví dụ phó nhóm). Trưởng nhóm lập **báo cáo ngày, tuần hoặc tháng**: số liệu tự lấy từ phần mềm theo loại bộ phận (số ca, thời gian đáp ứng, cuộc gọi nhỡ, phiếu đã ký, lô thuốc sắp hết hạn, thiết bị đến hạn, vệ sinh tay, sự cố, khiếu nại, thu chi, giờ chấm công...), cộng tóm tắt, vướng mắc, đề xuất, kế hoạch kỳ tới; nộp lên **trưởng bộ phận cấp trên**, người này duyệt hoặc trả lại (bắt buộc ghi lý do), rồi lập báo cáo của mình có sẵn tóm tắt các nhóm con; cuối cùng lên Ban Giám đốc. Không tự duyệt báo cáo nhóm mình; bảng theo dõi hiện nhóm chưa làm, đã nộp, trả lại, quá hạn (ngày: hạn 1 ngày, tuần: 2 ngày, tháng: 5 ngày sau kỳ) | 7.5 |
| Tài chính, kế toán | Ký phiếu chuyển viện là **tự sinh khoản thu** theo bảng giá loại xe (giá mở cửa gồm số km đầu, km tiếp theo, giờ chờ, phụ thu đêm) và số km kíp ghi trên phiếu; khách hàng hợp đồng (chiết khấu, hạn thanh toán) chọn ngay trên ca ở EOC; phiếu thu (tiền mặt, chuyển khoản có mã giao dịch); miễn, giảm, thất thu duyệt **theo hạn mức** (mặc định kế toán tới 500.000 đ, vượt mức Ban Giám đốc), người đề nghị không tự duyệt; hóa đơn (ghi số HĐĐT từ nhà cung cấp); đề xuất chi **2 cấp** (kế toán, từ ngưỡng 5 triệu thêm Ban Giám đốc), phiếu chi lớn phải gắn đề xuất đã duyệt; công nợ theo tuổi nợ; **Excel nhập MISA SME** (phiếu thu, thu tiền gửi, phiếu chi, chi tiền gửi, nghiệp vụ khác theo mẫu nhập khẩu, có trang hướng dẫn) và **bút toán CSV** (Nợ/Có, mã xe thống kê) cho Fast/Bravo; số hiệu tài khoản chỉnh được | 7.5 |
| Báo cáo | Trang **Báo cáo** theo khoảng ngày và điểm: vận hành (số ca theo mức, theo ngày/giờ; thời gian đáp ứng trung vị và phân vị 90 cho từng đoạn T0→T13; tỉ lệ đạt chỉ tiêu tới hiện trường P1 ≤ 15, P2 ≤ 30 phút; tỉ lệ sử dụng xe), chuyên môn (kết cục, chẩn đoán ICD-10, bệnh viện nhận, thuốc), chất lượng (sự cố/1000 ca, khiếu nại đúng hạn, hài lòng, vệ sinh tay, khử khuẩn), tài chính (doanh thu, đã thu, chi phí, chênh lệch theo tháng, xe, điểm); **tải Excel (CSV)** và **in/lưu PDF** | 6.2, 7.5 |
| Nhật ký và tài liệu | Xem nhật ký thao tác theo người, nhóm thao tác; nút kiểm tra toàn vẹn chuỗi băm; kiểm soát tài liệu (quy trình, hướng dẫn, biểu mẫu có phiên bản, hạn rà soát; Ban Giám đốc ban hành, bản mới thay bản cũ, người soạn không tự ban hành) | 6.3, 7.5 |
| Bộ tiêu chí chất lượng (QLCL-01, 02) | Khung chấm theo QĐ 6858/QĐ-BYT (5 mức, tiểu mục; có tiểu mục mức 1 là mức 1). Nạp sẵn **bộ 10 tiêu chí đơn vị cấp cứu ngoại viện** , **bộ 41 tiêu chí TTCC 115 TP.HCM (SYT 2024)** và **bộ 23 tiêu chí phòng khám (SYT bản 1.0, lấy từ MedOne phòng khám)** để tham khảo. **Tự sửa được**: nhân bản thành phiên bản dự thảo rồi sửa tên, căn cứ, khoa/phòng phụ trách, hệ số, tiểu mục từng mức ngay trên phần mềm, hoặc **tải Excel → sửa → nạp lại**; Ban Giám đốc ban hành, người soạn không tự ban hành. Đợt đánh giá (tự đánh giá, kiểm tra của Sở, đánh giá độc lập): **phân công người chấm từng tiêu chí**, phiếu chấm theo mẫu (thực trạng, phương pháp, giải trình, điểm phân vân, minh chứng, cải tiến, góp ý đoàn), mức tự tính từ tiểu mục, đổi mức phải giải trình; chốt kết quả; báo cáo tổng hợp như báo cáo kiểm tra của Sở (tiêu chí áp dụng, tổng điểm, điểm trung bình, phân bố theo mức, theo phần, so kỳ trước, **vấn đề ưu tiên cải tiến**), CSV, in | 7.5 |
| Tem QR thiết bị | Mỗi thiết bị có mã tài sản `TB-0001` và mã QR ngẫu nhiên; bộ dụng cụ cũng có QR. **In tem** A4 3 cột (QR 26 mm, mã, tên, số seri, nơi đặt) theo danh sách đang lọc; quét bằng camera điện thoại mở `/tb/<mã>` (chưa đăng nhập thì đăng nhập xong quay lại): tình trạng, hạn bảo dưỡng/kiểm định, **hướng dẫn sử dụng**, nút **Kiểm tra đầu ca**, ghi vệ sinh, báo hỏng; kỹ thuật ghi bảo dưỡng, kiểm định, sửa xong ngay tại chỗ; mất tem thì cấp mã mới, tem cũ hết tác dụng. Tem chứa địa chỉ trang web đang mở, nên điện thoại phải vào được địa chỉ đó | 7.5 |
| Bảng kê BHYT (QĐ 130/QĐ-BYT, sửa đổi QĐ 4750) | Tab **BHYT** ở Tài chính: các lượt đối tượng BHYT, kế toán nhập thẻ (mã thẻ, nơi ĐKBĐ, hạn, mức hưởng), hệ thống báo thiếu gì (mã KCB bệnh viện nhận, số km...); quỹ trả theo định mức nhiên liệu × km × giá xăng, phần chênh người bệnh trả; **xuất XML** gồm Bảng 1 và Bảng 3 (dòng `VC.<mã nơi đến>`) gói trong hồ sơ `GIAMDINHHS`, mỗi lượt chỉ xuất một lần (có nhật ký và mã băm). Chưa kê thuốc (Bảng 2), chưa ký số: tải lên Cổng giám định bằng công cụ ký số của đơn vị. Mã mặc định là bản nháp | 7.5 |
| Xác thực hai lớp | Ứng dụng xác thực trên điện thoại (Google/Microsoft Authenticator, chuẩn TOTP): trang **Bảo mật** nhập lại mật khẩu, quét QR, nhập mã đầu tiên, nhận 10 **mã dự phòng** dùng một lần; đăng nhập cần mật khẩu và mã 6 số; nhập sai 5 lần khóa 15 phút; mã đã dùng không dùng lại được; khóa TOTP mã hóa AES-GCM. Quản trị chọn vai trò bắt buộc (mặc định điều phối viên, trưởng ca, kế toán, Ban Giám đốc, quản trị) và bật **Bắt buộc ngay** khi mọi người đã cài: người chưa cài chỉ vào được trang cài đặt. Mất điện thoại thì quản trị khác đặt lại | 12.5 |
| Hạn mức phê duyệt | Ban Giám đốc đặt hạn mức ở trang **Bảo mật**: miễn/giảm phí theo số tiền cho từng vai trò; **rút xe** và **hủy ca đã điều xe** vẫn làm ngay (việc khẩn) nhưng vượt số lần trong ngày thì vào danh sách **Hậu kiểm** cho trưởng ca (đồng ý hoặc không đồng ý có lý do, ghi nhật ký); số mục chờ hiện trên thanh điều hướng | 7.5 |
| Liên thông FHIR với bệnh viện | Trang phiếu có nút **Tải FHIR (JSON)**: phiếu chuyển viện xuất theo **HL7 FHIR R4**, dạng Bundle `document` (Composition đứng đầu, có phần tóm tắt dễ đọc) gồm Patient (Số BA; số CCCD chỉ 4 số cuối), Encounter (cấp cứu, mã ca, số chuyển viện, mốc thời gian, bệnh viện nhận kèm mã KCB), Practitioner (kíp, số GPHN), Observation sinh hiệu theo mã **LOINC** (mạch, huyết áp, SpO2, nhịp thở, nhiệt độ, GCS, đường huyết, đau), Condition **ICD-10**, Procedure (can thiệp), MedicationAdministration (thuốc, liều, đường dùng, số lô), AllergyIntolerance. Trưởng ca, QLCL, quản trị tải được bản kèm số định danh đầy đủ; mỗi lượt tải ghi nhật ký. Tên đơn vị lấy từ `MEDONE_ORG_NAME`. Chưa gửi tự động sang máy chủ FHIR của bệnh viện (cần bệnh viện cấp địa chỉ và khóa) | 12.7 |
| Vùng phủ, vùng bị hở | Trang **Vùng phủ** (điều phối, trưởng ca, QLCL, Ban Giám đốc): địa bàn chia ô 1 km, mỗi ô tô màu theo thời gian xe gần nhất tới được (trong chỉ tiêu, gần quá, bị hở), chấm đen là ca thật trong 30–365 ngày qua (lọc mọi ca, P1, P1–P2); kịch bản **hiện tại** (chỉ xe đang sẵn sàng, ở vị trí hiện tại) hoặc **đủ xe** (mọi xe trực đứng tại trạm); bỏ chọn một xe để xem nếu xe đó đi làm thì hở chỗ nào; tỉ lệ diện tích và tỉ lệ ca nằm trong vùng tới kịp; **gợi ý 3 chỗ đặt xe tạm trú** phủ thêm nhiều ca nhất. Bảng đội xe có huy hiệu **Vùng phủ %** (xanh ≥ 90%, cam ≥ 75%, đỏ dưới) cập nhật khi xe đổi trạng thái. Thời gian ước tính theo khoảng cách như phần gợi ý xe, chưa có giao thông | 12.5, 12.7 |
| Tổng đài SIP và ghi âm | Tổng đài **Asterisk** tự cài (không phụ thuộc nhà cung cấp): lệnh `npm run asterisk:config` sinh toàn bộ cấu hình (máy lẻ, hàng chờ `dieu-phoi`, ghi âm, webhook, ARI). Cuộc gọi 1800/115 vào hàng chờ hiện ngay trên màn hình EOC; điều phối viên **nhấc máy lẻ trên điện thoại là màn hình của họ tự mở ca** (Mã ca tính T0 lúc chuông reo). Mọi cuộc gọi được **ghi âm**, gác máy thì lưu tệp, thời lượng và **mã băm SHA-256**; trưởng ca, QLCL, quản trị, Ban Giám đốc **nghe lại** ngay trên ca và trang truy xuất (tua được, báo nếu tệp bị sửa, mỗi lượt nghe ghi nhật ký). Nút **Gọi lại** cho cuộc gọi bỏ dở và số gọi lại của ca: máy lẻ của mình đổ chuông, nhấc máy thì tổng đài quay số, cuộc gọi ra cũng được ghi âm. Quản trị gán máy lẻ cho người trực ở trang **Quản trị** | 5.1, 5.2, 6.3 |
| Chép lời cuộc gọi | Ghi âm cuộc gọi đã có người nghe được **chép thành chữ** bằng máy chép lời đơn vị tự cài trong mạng nội bộ (whisper.cpp server, faster-whisper-server, LocalAI: chuẩn `/audio/transcriptions`), ghi âm không gửi ra ngoài. Tắt sẵn; đặt `MEDONE_ASR_URL` là chạy nền. Trưởng ca, QLCL, quản trị, Ban Giám đốc **xem lời thoại** ngay dưới ghi âm, chép lại khi lỗi; tab **Chất lượng → Lời thoại cuộc gọi** tìm cuộc gọi theo cụm từ ("ngừng thở", "co giật") để rà soát. Mỗi lượt xem, tìm ghi nhật ký. Lời máy chép có thể sai: đối chiếu với ghi âm | 6.3, 12.7 |
| Đăng nhập một lần (SSO) | Chuẩn **OpenID Connect** (luồng mã + PKCE): dùng với **Keycloak** tự cài, Microsoft Entra ID, Google Workspace. Tắt sẵn; đặt biến `MEDONE_OIDC_*` là trang đăng nhập có thêm nút. Tài khoản vẫn do quản trị tạo trong Medone: lần đầu nối theo tên đăng nhập, từ đó nhận theo mã người dùng của máy chủ SSO (đổi tên không mất nối, trùng tên không chiếm được tài khoản đã nối). Tài khoản bị khóa trong Medone không vào được; ai đã cài xác thực hai lớp vẫn nhập mã 6 số. Mặc định bắt nhập lại mật khẩu ở máy chủ SSO mỗi lần, vì máy trực dùng chung theo ca. Quản trị thấy nhãn SSO và gỡ nối được; mọi lần nối, từ chối, đăng nhập đều ghi nhật ký | 12.5 |
| Điểm, trạm do quản trị quyết định | Tài khoản `admin` thêm/sửa/tạm ngưng điểm (trụ sở, trạm xe, kho trung tâm, điểm trực sự kiện), đặt tọa độ trên bản đồ, chuyển xe giữa các điểm, phân nhân viên về điểm; kíp chỉ nhận được xe thuộc điểm mình | 5.5 |

## Chưa có trong bản này (theo đúng lộ trình)

Trung kế nhà mạng cho đầu số 1800/115 (đã có mẫu cấu hình, cần hợp đồng với nhà mạng); bản đồ Việt Nam có giao thông
(đang dùng OpenStreetMap và ước tính theo khoảng cách); chữ ký số CA; gửi FHIR tự động sang máy chủ của bệnh viện (đã xuất được tệp FHIR); ứng dụng Android gốc
(bản này là ứng dụng web cài được, chạy offline). Xem mục 12.5, 12.7 của kế hoạch.

## Kiến trúc 3 lớp

| Lớp | Công nghệ | Thư mục | Cổng |
|---|---|---|---|
| Frontend | Next.js 16 (React 19, TypeScript, App Router), giao diện chia component, ứng dụng web cài được (PWA) | `web/` | 3000 |
| Backend | Fastify 5 (TypeScript): API REST, WebSocket thời gian thực, **xác thực và phân quyền ở backend** (JWT, mật khẩu băm scrypt, kiểm tra vai trò trên từng API) | `server/` | 8080 |
| Database | PostgreSQL 16, lược đồ khai báo rõ trong `server/migrations/` | | 5432 |

Trình duyệt chỉ gọi backend qua API; frontend không đọc cơ sở dữ liệu. Quản lý gói bằng **npm** (npm workspaces).

**Dữ liệu và lược đồ:** mỗi loại dữ liệu có bảng riêng với cột, khóa và ràng buộc rõ ràng (ca cấp cứu, cuộc gọi, xe, kíp, bệnh nhân,
phiếu chuyển viện, mốc thời gian, nhật ký...). Phần nội dung biểu mẫu thay đổi theo mẫu giấy (ePCR, câu trả lời phân loại,
tiền sử bệnh nhân, nội dung nhật ký) lưu dạng **JSON (JSONB)** trong cột của bảng tương ứng, và được kiểm tra bằng lược đồ zod ở backend
(`server/src/epcr.ts`) trước khi ghi.

**Không ghi cứng khóa hay mật khẩu:** mọi khóa bí mật và chuỗi kết nối cơ sở dữ liệu đọc từ tệp `.env` (nằm trong `.gitignore`).
Thiếu khóa thì backend dừng ngay, kể cả khi chạy thử. `npm run setup` sinh tệp `.env` với khóa ngẫu nhiên. Mật khẩu tài khoản mẫu
lấy từ `MEDONE_SEED_PASSWORD` hoặc được sinh ngẫu nhiên và in ra một lần; trong cơ sở dữ liệu chỉ lưu bản băm.

## Chạy thử

Cần Node.js 22 và PostgreSQL 16.

```bash
npm install
npm run setup                         # tạo .env với khóa ngẫu nhiên, in lệnh tạo tài khoản PostgreSQL
# chạy các lệnh CREATE ROLE / CREATE DATABASE mà bước trên in ra
npm run seed                          # 6 xe, 3 trạm, 10 vị trí EOC, kíp mẫu; in mật khẩu tài khoản mẫu
npm run start:server                  # backend http://localhost:8080
npm run build && npm run start:web    # frontend http://localhost:3000
```

Hoặc chạy cả 3 lớp bằng Docker: `npm run setup`, rồi `docker compose up --build`, rồi `docker compose exec api npx tsx server/src/seed.ts`.

Tài khoản mẫu: `dpv01`–`dpv05` tiếp nhận cuộc gọi, `dpv06`–`dpv10` điều phối viên, `truongca`, `qlcl`, `admin`,
kíp `bs.als`, `dd.als`, `ys.bls`, `bs.msu`, `dd.vc`; phân hệ quản trị `duoc` (kho – dược), `kythuat` (thiết bị), `ksnk`,
`nhansu`, `ketoan`, `giamdoc`. Mật khẩu là mật khẩu `npm run seed` in ra. Mọi người dùng có trang **Cá nhân** (chấm công, lịch trực, xin nghỉ, đề xuất chi). Admin tạo thêm tài khoản ở trang **Quản trị**.

Cơ sở dữ liệu thử đã có từ bản trước: `npm run demo:ops -w server` thêm tài khoản quản trị mẫu, thiết bị mẫu cho từng xe
(nếu không, xe sẽ bị chặn vì thiếu thiết bị bắt buộc), bù cơ số xe và bộ dụng cụ mẫu. Không chạy lệnh này trên dữ liệu thật.

Thử một ca: đăng nhập `bs.als` trên máy tính bảng/điện thoại và bắt đầu ca trên xe MD-ALS-01; đăng nhập `dpv01` trên máy khác,
bấm **Giả lập cuộc gọi** → **Nhận** → nhập địa chỉ, bấm bản đồ → trả lời câu hỏi → **Xác nhận**; đăng nhập `dpv06` để **Giao** xe.

**Danh mục:** `npm run seed` tự nạp danh mục bệnh viện, ICD-10 và thuốc từ `server/data/`. Nạp lại (sau khi cập nhật bản mới):
`npm run catalog -w server`. Nạp từ tệp khác: `npm run import:icd -w server -- <tệp .xlsx/.csv>`,
`npm run import:hospitals -w server -- <tệp .csv>`.

**HTTPS trong mạng nội bộ** (điện thoại kíp chỉ được lấy GPS khi trang mở bằng https):
`npm run https:cert` tạo một CA nội bộ và chứng chỉ cho tên `.local`, `localhost` và IP mạng nội bộ của máy (khóa nằm ở `certs/`, không đưa lên git);
`npm run start:https` mở `https://<tên máy>.local:3443`, gom web và API về một địa chỉ (`/api`, `/ws` sang cổng 8080, còn lại sang 3000),
kèm trang hướng dẫn cài chứng chỉ ở `http://<tên máy>.local:3080`. Mỗi điện thoại cài và tin CA một lần. Đổi tên máy hoặc IP thì chạy lại
`npm run https:cert` rồi khởi động lại cổng HTTPS; CA giữ nguyên nên không phải cài lại trên điện thoại.

Phát triển: `npm run dev:server` và `npm run dev:web` (Next.js ở cổng 3000, gọi backend theo `NEXT_PUBLIC_API_URL`).

## Kiểm thử

```bash
npm test                              # 63 kiểm thử (dùng TEST_DATABASE_URL trong .env): phân loại, mã hóa, chuỗi băm, gợi ý xe, trọn luồng một ca
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
web/      Next.js + React + TypeScript
  app/               các trang (App Router)
  src/screens/       màn hình: điều phối, bảng xe, ứng dụng kíp, bệnh án, truy xuất, phiếu in
  src/components/    component dùng chung: bảng xe, bản đồ, phân loại, form ePCR...
```

**Vì sao không dùng Java/Spring như mục 12.2 đề xuất:** để có bản chạy được sớm với một ngôn ngữ cho cả máy chủ, màn hình EOC và
ứng dụng kíp offline. Kiến trúc giữ đúng nguyên tắc của kế hoạch (PostgreSQL, bảng sự kiện chỉ ghi thêm, outbox thay Kafka,
WebSocket, phần sống còn tách khỏi hành chính); đội phát triển chính thức có thể giữ hoặc viết lại phần máy chủ sau giai đoạn 0.

## Nối tổng đài Asterisk

1. Cài Asterisk 20 trở lên trên máy chủ (Ubuntu: `sudo apt install asterisk`; Docker: một ảnh Asterisk bất kỳ có `res_ari`, `app_queue`, `func_curl`).
2. Sinh cấu hình (chạy lại không đổi mật khẩu đã cài trên điện thoại):
   ```
   cd server
   npm run asterisk:config -- --may-le=101-110 --api=http://127.0.0.1:8080 --ghi-am=/var/lib/medone/ghi-am --duong-115=<số DID của đường 115>
   ```
   Lệnh ghi vào `deploy/asterisk/generated/` (không đưa lên Git): các tệp `.conf`, tệp `may-le.txt` (mật khẩu từng máy lẻ, quyền 600)
   và thêm biến ARI, thư mục ghi âm vào `.env`. Mật khẩu không in ra màn hình.
3. Chạy: `asterisk -C deploy/asterisk/generated/asterisk.conf` (hoặc chép các tệp vào `/etc/asterisk`). Khởi động lại backend để đọc `.env` mới.
4. Cài tài khoản SIP trên điện thoại bàn hoặc phần mềm (Zoiper, Linphone, MicroSIP): máy chủ là địa chỉ máy tổng đài, tên là số máy lẻ,
   mật khẩu lấy trong `may-le.txt`.
5. Trang **Quản trị → Tổng đài và máy lẻ**: gán máy lẻ cho từng điều phối viên. Chưa có trung kế thì gọi **1800** từ một máy lẻ để giả lập
   người báo vào hàng chờ.
6. Trung kế nhà mạng: điền khối `nha-mang` (đang để chú thích) trong `pjsip.conf` theo thông số nhà mạng cấp, rồi `pjsip reload`.

Ghi âm nằm trên đĩa máy tổng đài; backend cần đọc được thư mục đó (cùng máy hoặc thư mục chia sẻ). Lưu giữ và sao lưu ghi âm theo quy định
lưu hồ sơ của đơn vị.

## Máy chép lời cuộc gọi

Chạy một máy chủ chép lời có giao tiếp `/v1/audio/transcriptions` trên máy trong mạng nội bộ, ví dụ whisper.cpp:
`whisper-server -m ggml-large-v3-turbo.bin --host 127.0.0.1 --port 8178 --inference-path /v1/audio/transcriptions -l vi`
(máy Mac Apple Silicon chạy tốt mô hình large-v3-turbo). Đặt `MEDONE_ASR_URL=http://127.0.0.1:8178/v1` rồi khởi động lại backend.
Mô hình nhỏ (base, small) nghe tiếng Việt qua điện thoại kém; nên thử với vài cuộc gọi thật trước khi dựa vào.

## Đăng nhập một lần với Keycloak

1. Trên Keycloak tạo realm (ví dụ `medone`) và client `medone`: Client authentication bật, Standard flow bật, Valid redirect URIs là
   `https://<địa chỉ web>/dang-nhap`, PKCE `S256`. Lấy client secret ở tab Credentials.
2. Thêm vào `.env` rồi khởi động lại backend:
   `MEDONE_OIDC_ISSUER=https://<keycloak>/realms/medone`, `MEDONE_OIDC_CLIENT_ID=medone`, `MEDONE_OIDC_CLIENT_SECRET=<secret>`,
   tùy chọn `MEDONE_OIDC_LABEL` (chữ trên nút), `MEDONE_OIDC_REDIRECT_URI` (mặc định `<MEDONE_WEB_ORIGIN đầu tiên>/dang-nhap`).
3. Tên đăng nhập trên Keycloak phải trùng tên đăng nhập trong Medone (hoặc đổi `MEDONE_OIDC_USERNAME_CLAIM`, ví dụ `email` nếu tên Medone là email).
4. Máy riêng từng người thì đặt `MEDONE_OIDC_PROMPT=-` để đã đăng nhập Keycloak là vào thẳng; máy trực dùng chung giữ mặc định.

Đăng nhập bằng mật khẩu Medone vẫn dùng được song song (để quản trị vào được khi máy chủ SSO hỏng).

## Chữ ký số nội bộ

Ký phiếu chuyển viện (và ký bản bổ sung) tạo thêm một chữ ký số ECDSA P-256 bằng chứng thư của người ký. Medone tự làm CA gốc
(tạo lần đầu khi cần, hiệu lực 10 năm) và tự cấp chứng thư 1 năm cho từng người khi họ ký lần đầu; khóa bí mật mã hóa bằng `MEDONE_DATA_KEY`.
Phiếu, bản in và trang tra cứu công khai hiện chữ ký còn hợp lệ hay không: sửa nội dung, sửa chữ ký, chứng thư lạ hoặc bị thu hồi trước lúc ký đều bị báo.
Quản trị → Chữ ký số nội bộ: tải chứng thư CA (`/api/pki/ca.pem`) gửi bệnh viện đối chiếu, xem chứng thư, thu hồi khi nghỉ việc hoặc mất máy.
Giá trị pháp lý: trong nội bộ và với đơn vị đã thỏa thuận. Giai đoạn sau thêm CA công cộng (MobiFone CA, VNPT SmartCA, Viettel MySign) vào
`SIGNING_PROVIDERS` trong `server/src/pki.ts` và chọn bằng `MEDONE_SIGN_PROVIDER`.

## Biến môi trường

Tất cả nằm trong `.env` (tạo bằng `npm run setup`): `DATABASE_URL`, `MEDONE_JWT_SECRET`, `MEDONE_DATA_KEY` (mã hóa số định danh),
`MEDONE_LOOKUP_KEY` (tìm kiếm), `MEDONE_TELEPHONY_KEY` (webhook tổng đài), `MEDONE_WEB_ORIGIN` (địa chỉ frontend được phép gọi API),
`NEXT_PUBLIC_API_URL` (địa chỉ backend cho frontend), `NEXT_PUBLIC_VERIFY_URL` (địa chỉ công khai của trang tra cứu mã phiếu in trên QR; để trống là địa chỉ máy chủ đang mở), `MEDONE_AUTO_DISPATCH_KM` (bán kính tự báo xe, mặc định 5), `MEDONE_SMS_URL` và `MEDONE_SMS_TOKEN` (cổng SMS của nhà cung cấp: máy chủ POST JSON `{to, message, purpose, ref}` kèm `Authorization: Bearer`; để trống thì tin nằm trong hàng đợi để gửi tay), `MEDONE_ORG_NAME` (tên đơn vị ghi trên tệp FHIR gửi bệnh viện), `MEDONE_RECORDINGS_DIR` (thư mục tổng đài ghi âm), `MEDONE_ARI_URL`, `MEDONE_ARI_USER`, `MEDONE_ARI_PASSWORD` (ARI của Asterisk để gọi ra; lệnh `npm run asterisk:config` tự thêm cả bốn biến), `MEDONE_OIDC_ISSUER`, `MEDONE_OIDC_CLIENT_ID`, `MEDONE_OIDC_CLIENT_SECRET`, `MEDONE_OIDC_LABEL`, `MEDONE_OIDC_REDIRECT_URI`, `MEDONE_OIDC_USERNAME_CLAIM`, `MEDONE_OIDC_PROMPT` (đăng nhập một lần, xem dưới), `MEDONE_ASR_URL` (máy chép lời, ví dụ `http://127.0.0.1:8178/v1`), `MEDONE_ASR_KEY`, `MEDONE_ASR_MODEL` (mặc định `whisper-1`), `MEDONE_ASR_LANGUAGE` (mặc định `vi`), `MEDONE_SIGN_PROVIDER` (nhà cung cấp chữ ký số, mặc định `noi_bo`). Khóa phải dài ít nhất 32 ký tự; thiếu là backend không chạy.
**Mất `MEDONE_DATA_KEY` là mất khả năng đọc số CCCD đã lưu**: cất khóa trong kho khóa (HSM/KMS) và có bản sao.
