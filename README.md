# ZippyDrive

Tải nguyên cục Google Drive về máy dưới dạng **1 file .zip duy nhất** — không đăng nhập, không giới hạn dung lượng, chạy trên mọi trình duyệt.

## Tính năng

- **Streaming không tràn RAM** — nén từng file một, không buffer toàn bộ folder, xử lý được folder hàng chục GB trên server free (512MB RAM)
- **Giữ nguyên cấu trúc thư mục** trong file zip
- **Google Docs/Sheets/Slides** tự động chuyển sang `.docx` / `.xlsx` / `.pptx`
- **3 kiến trúc tải** (tự động chọn theo cấu hình):
  - **A (mặc định)** — qua server, zip trên server, mọi trình duyệt + mobile
  - **B** — tải thẳng từ Google Drive, ráp zip ngay trên máy (File System Access API, Chrome/Edge desktop)
  - **C** — tải thẳng từ Google Drive, ra nhiều file rời (fallback khi không có FSA)
- **Hàng đợi FIFO** — server đông thì xếp hàng, không từ chối
- **Real-time progress** qua SSE — hiện %, tên file đang xử lý, vị trí hàng đợi
- **Xem danh sách file** trước khi tải (tối đa 200 file)
- **Đổi tên** file zip đầu ra
- **Thông báo desktop** khi tải xong (tùy chọn)
- **Huỷ tải** giữa chừng (Architecture B/C)
- **Basic Auth** tùy chọn để bảo vệ trang riêng tư
- **Security headers** đầy đủ (CSP, X-Frame-Options, ...)
- File bị lỗi → ghi vào `_file_bi_loi.txt` bên trong zip

## Cài đặt

### Yêu cầu

- Node.js 18.18+ để chạy ứng dụng (yêu cầu của Next.js 15); chạy `npm test` cần **Node.js 22.6+** (dùng `--experimental-strip-types`)
- Google Drive API key (xem bên dưới)

### Tạo Google API Key

1. Vào [Google Cloud Console](https://console.cloud.google.com/)
2. Tạo project mới → **APIs & Services → Enable APIs**
3. Bật **Google Drive API**
4. **Credentials → Create credentials → API key**
5. (Nên làm) Giới hạn key: **API restrictions → chỉ Google Drive API** (key không dùng được cho API khác nếu bị lạm dụng).
   Với key **server** này, **đừng** đặt *Application restrictions → HTTP referrers*: request từ server không có header `Referer` nên Google sẽ từ chối toàn bộ. Muốn khoá thêm thì dùng *IP addresses* (IP gửi đi của dịch vụ hosting). Giới hạn *HTTP referrers* chỉ dành cho key **client** `NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT`.

### Chạy local

```bash
git clone https://github.com/yourname/zippydrive   # thay bằng URL repo của bạn
cd zippydrive
npm install

# Copy và chỉnh file env
cp .env.example .env.local
# Điền GOOGLE_API_KEY vào .env.local

npm run dev
```

Mở [http://localhost:3000](http://localhost:3000).

### Deploy lên Render (free)

1. Fork repo → kết nối với [Render](https://render.com)
2. Tạo **Web Service**, chọn repo
3. Build command: `npm run build`
4. Start command: `npm start`
5. Thêm biến môi trường:

| Biến | Bắt buộc | Mô tả |
|------|----------|-------|
| `GOOGLE_API_KEY` | ✅ | API key server-side (Architecture A) |
| `NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT` | ❌ | API key client-side (bật Architecture B/C). Được nhúng vào bundle lúc **build** — đổi giá trị phải build lại |
| `MAX_CONCURRENT_DOWNLOADS` | ❌ | Số lượt tải song song (mặc định: 3) |
| `MAX_QUEUE_LENGTH` | ❌ | Số lượt tối đa được xếp hàng chờ slot (mặc định: 20). Đầy thì server trả lỗi 503 "đang rất đông" thay vì nhận thêm |
| `MAX_FILES_PER_DOWNLOAD` | ❌ | Số file tối đa trong 1 lần quét/tải (mặc định: 20000) — chặn folder khổng lồ ngốn RAM/quota của server |
| `DOWNLOAD_IDLE_TIMEOUT_SECONDS` | ❌ | Quá ngần này giây không có dữ liệu nào di chuyển (Google hoặc trình duyệt ngừng phản hồi) thì dừng lượt tải để trả slot (mặc định: 600) |
| `MAX_TOTAL_DOWNLOAD_BYTES` | ❌ | Giới hạn dung lượng tối đa (mặc định: không giới hạn) |
| `BASIC_AUTH_USER` | ❌ | Username Basic Auth (tắt nếu không set) |
| `BASIC_AUTH_PASS` | ❌ | Password Basic Auth — **cần set cả hai** biến Basic Auth mới bật; chỉ set một biến thì server ghi cảnh báo và vẫn để trang mở |

## Chạy test

```bash
npm test           # unit test (Node.js 22.6+)
npm run typecheck  # kiểm tra kiểu TypeScript toàn dự án
```

## Giới hạn thực tế

- Chỉ đọc được file/folder đã bật **"Anyone with the link"**
- Không hỗ trợ resume khi mất mạng giữa chừng
- Google Forms, Sites, Maps, Jamboard và shortcut không export được — bị bỏ qua và được liệt kê trong `_file_bi_loi.txt` bên trong zip. Google Docs/Sheets/Slides chỉ export được khi dung lượng sau export nhỏ hơn ~10MB (giới hạn của Google)
- File trùng tên trong cùng một thư mục (Drive cho phép) được tự đổi thành `tên (2).đuôi`, `tên (3).đuôi`... để không bị ghi đè khi giải nén
- Nếu kết nối tới Google đứt **giữa chừng** một file, lượt tải bị dừng hẳn và trình duyệt báo tải thất bại (không để treo, không trả file zip thiếu dữ liệu nhìn như đã xong) — hãy bấm tải lại
- Lỗi xảy ra ngay lúc bắt đầu (link sai, hàng đợi đầy...) được báo ngay trong giao diện, không chuyển sang trang lỗi trắng
- Render free: 512MB RAM, 100GB băng thông/tháng
- Hàng đợi và tiến độ nằm trong bộ nhớ của MỘT tiến trình Node: đúng cho 1 instance (Render/VPS), không dùng được cho serverless hay chạy nhiều instance song song
- Shared Drives (Google Workspace): code có gửi kèm `supportsAllDrives`/`includeItemsFromAllDrives` khi gọi API, nhưng chưa được kiểm thử đầy đủ với nội dung nằm trong Shared Drive thật — có thể hoạt động tùy cấu hình quyền của tổ chức, chưa đảm bảo 100%

## License

MIT
