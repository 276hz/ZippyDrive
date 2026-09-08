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

- Node.js 18+
- Google Drive API key (xem bên dưới)

### Tạo Google API Key

1. Vào [Google Cloud Console](https://console.cloud.google.com/)
2. Tạo project mới → **APIs & Services → Enable APIs**
3. Bật **Google Drive API**
4. **Credentials → Create credentials → API key**
5. (Tùy chọn) Giới hạn key: chỉ cho phép **Google Drive API**, chỉ từ domain của bạn

### Chạy local

```bash
git clone https://github.com/yourname/zippydrive
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
| `NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT` | ❌ | API key client-side (bật Architecture B/C) |
| `MAX_CONCURRENT_DOWNLOADS` | ❌ | Số lượt tải song song (mặc định: 3) |
| `MAX_TOTAL_DOWNLOAD_BYTES` | ❌ | Giới hạn dung lượng tối đa (mặc định: không giới hạn) |
| `BASIC_AUTH_USER` | ❌ | Username Basic Auth (tắt nếu không set) |
| `BASIC_AUTH_PASS` | ❌ | Password Basic Auth (tắt nếu không set) |

## Chạy test

```bash
node --test lib/client-drive.test.ts
```

## Giới hạn thực tế

- Chỉ đọc được file/folder đã bật **"Anyone with the link"**
- Không hỗ trợ resume khi mất mạng giữa chừng
- Google Forms, Sites, Maps, Jamboard không export được — tự bỏ qua
- Render free: 512MB RAM, 100GB băng thông/tháng
- Không hỗ trợ Shared Drives (Google Workspace) trừ khi API key có quyền

## License

MIT
