# ZippyDrive

**Dán link Google Drive công khai (folder hoặc file) → hốt trọn về máy dưới dạng 1 file `.zip` duy nhất.**

Free 100%, không đăng nhập, không giới hạn dung lượng mặc định, chạy mượt trên mọi trình duyệt (desktop lẫn mobile).

Đang chạy thật tại: **http://zippydrive.onrender.com**

## ✨ Có gì trong này

- **1 link → 1 zip**: dán link Drive công khai → xem trước số file/dung lượng → bấm 1 nút, luôn ra đúng **1 file `.zip` duy nhất**, không chia nhỏ thành nhiều phần.
- **Không giới hạn dung lượng (mặc định)**: nén kiểu streaming, xử lý từng file một — không giữ cả file trong RAM, nên folder to cỡ nào cũng tải được. Có thể tự đặt lại giới hạn qua env nếu muốn (xem bên dưới).
- **Tự retry khi lỗi mạng/429**: mỗi file thử lại tối đa 3 lần với backoff tăng dần trước khi bị bỏ qua.
- **Không giấu lỗi**: file nào tải fail sẽ được liệt kê kèm lý do trong 1 file `_file_bi_loi.txt` nằm ngay trong zip, thay vì âm thầm thiếu file.
- **Hàng đợi thông minh**: nhiều người tải cùng lúc sẽ tự xếp hàng (mặc định 3 lượt xử lý song song) thay vì bị từ chối — thấy vị trí xếp hàng real-time qua SSE, không cần bấm lại.
- **Tự chuyển định dạng**: Google Docs/Sheets/Slides tự export sang `.docx`/`.xlsx`/`.pptx`.
- **Đổi tên trước khi tải**: sửa tên file zip đầu ra ngay trên giao diện.
- **Basic Auth tuỳ chọn**: bật bằng 2 biến môi trường nếu muốn giới hạn ai được dùng.
- **Tiến độ thật**: % hoàn tất, tên file đang nén, số file lỗi — cập nhật real-time qua Server-Sent Events, không phải animation giả.

## 🏗️ Cách hoạt động

1. `app/api/list` — gọi Google Drive API v3, liệt kê đệ quy toàn bộ file trong folder, tính tổng số lượng/dung lượng.
2. `app/api/download` — dùng `archiver` nén zip kiểu streaming trên server: mở trước tối đa 3 kết nối Drive song song (giấu độ trễ mạng) nhưng chỉ GHI vào zip từng file một, đúng thứ tự — vừa nhanh vừa không tràn RAM. Có hàng đợi (`lib/download-lock.ts`) giới hạn số lượt xử lý nặng cùng lúc trên toàn server.
3. `app/api/progress` — kênh SSE báo tiến độ real-time (% hoàn tất, vị trí xếp hàng, file lỗi) dựa trên `token` do client tự sinh.
4. Trình duyệt nhận response zip như 1 lượt tải file bình thường — ghi thẳng ra đĩa qua tầng mạng hệ điều hành, không tốn RAM của trang web.

## 📁 Cấu trúc project

```
app/
  page.tsx                     # Giao diện: nhập link, xem trước, đổi tên, tải, tiến độ, lịch sử
  api/list/route.ts            # Liệt kê đệ quy nội dung folder + tính tổng dung lượng
  api/download/route.ts        # Nén streaming + hàng đợi + retry + báo file lỗi
  api/proxy/route.ts           # Proxy tải 1 file lẻ (khi link là file, không phải folder)
  api/progress/route.ts        # SSE báo tiến độ/vị trí hàng đợi real-time
  api/download-status/route.ts # Endpoint tham khảo trạng thái server (active/queue)
lib/
  drive.ts                     # Gọi Google Drive API v3, retry, giới hạn size, header đa ngôn ngữ
  download-lock.ts             # Hàng đợi FIFO giới hạn số lượt tải nặng cùng lúc
  progress-store.ts            # Lưu tạm tiến độ tải theo token (trong RAM)
middleware.ts                  # Basic Auth tuỳ chọn cho toàn trang
```

## ⚠️ Giới hạn thật (nói thẳng, không giấu)

- Chỉ đọc được file/folder đã bật **"Anyone with the link"** — không truy cập được file riêng tư.
- Định dạng Google gốc không export được (Forms, Sites, Maps, Jamboard...) sẽ tự bị bỏ qua khi đóng gói.
- Không có tính năng "tải tiếp" (resume) — mất mạng giữa chừng phải tải lại từ đầu.
- Google có thể tạm khoá 1 file 24h nếu bị tải với băng thông bất thường trong thời gian ngắn (lỗi *"Too many users..."*) — giới hạn này gắn với chính file trên Drive, không phải do code hay API key.
- Chạy trên gói Render free: 512MB RAM, 100GB băng thông/tháng dùng chung toàn workspace — vượt mốc này Render tự đình chỉ service tới tháng sau.

## 🚀 Chạy thử ở máy local

```bash
npm install
cp .env.example .env.local
# Mở .env.local, điền Google API Key vào GOOGLE_API_KEY=

npm run dev
# Mở http://localhost:3000
```

Các biến môi trường khác (đều tuỳ chọn, xem chi tiết trong `.env.example`):

| Biến | Mặc định | Tác dụng |
|---|---|---|
| `MAX_TOTAL_DOWNLOAD_BYTES` | không giới hạn | Chặn tải nếu folder vượt dung lượng đặt ra |
| `MAX_CONCURRENT_DOWNLOADS` | 3 | Số lượt tải zip xử lý song song trước khi phải xếp hàng |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | trống (tắt) | Bật Basic Auth cho toàn trang khi cả 2 đều có giá trị |

## 🛠️ Công nghệ dùng

- [Next.js 15](https://nextjs.org/) (App Router) + React 19 + TypeScript
- [Tailwind CSS](https://tailwindcss.com/) — hệ màu "kraft + mực đóng dấu" tự định nghĩa (`tailwind.config.ts`)
- [lucide-react](https://lucide.dev/) — icon
- [archiver](https://www.npmjs.com/package/archiver) — nén zip streaming phía server
- Be Vietnam Pro + JetBrains Mono (`next/font/google`) — font chuẩn dấu tiếng Việt
- Google Drive API v3 — đọc file/folder công khai

---

**Về quyền riêng tư**: tool chỉ đọc nội dung người dùng đã chủ động chia sẻ ở chế độ "Anyone with the link" thông qua Google API Key công khai — không đăng nhập, không truy cập, không chỉnh sửa bất kỳ dữ liệu riêng tư nào của ai.
