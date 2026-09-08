import { NextRequest, NextResponse } from 'next/server';

/**
 * So sánh hằng thời gian (constant-time) thuần JavaScript — KHÔNG dùng
 * `Buffer.equals()` vì phương thức đó (giống memcmp chuẩn) có thể dừng ngay
 * khi gặp byte đầu tiên khác nhau, vẫn lộ thời gian phản hồi theo độ dài phần
 * trùng khớp. Cũng không dùng `crypto.timingSafeEqual` của Node vì middleware
 * mặc định chạy trên Edge Runtime (không khai báo `runtime: 'nodejs'` bên
 * dưới), nơi module `crypto` của Node không đảm bảo có sẵn. Hàm này luôn
 * duyệt hết độ dài lớn nhất của 2 chuỗi bằng XOR tích luỹ, không rẽ nhánh theo
 * nội dung, nên chạy đúng và nhất quán trên mọi runtime.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    const charA = i < a.length ? a.charCodeAt(i) : 0;
    const charB = i < b.length ? b.charCodeAt(i) : 0;
    diff |= charA ^ charB;
  }
  return diff === 0;
}

/**
 * HTTP Basic Auth cho toàn bộ trang — CHỈ bật khi cả 2 biến môi trường
 * `BASIC_AUTH_USER` và `BASIC_AUTH_PASS` đều được cấu hình trên Render. Nếu
 * không set (mặc định), middleware bỏ qua hoàn toàn — không đổi hành vi cũ.
 *
 * Lý do cần: trang không có đăng nhập, ai có link Render đều dùng chung
 * GOOGLE_API_KEY và tài nguyên server của bạn. Basic Auth là lớp bảo vệ đơn
 * giản nhất, không tốn thêm dịch vụ nào, trình duyệt hỗ trợ sẵn (hiện popup
 * nhập user/pass, không cần code thêm UI).
 */
export function middleware(req: NextRequest) {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;

  if (!user || !pass) return NextResponse.next(); // chưa cấu hình -> không bật auth

  const authHeader = req.headers.get('authorization');
  if (authHeader) {
    const [scheme, encoded] = authHeader.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
      const sepIndex = decoded.indexOf(':');
      const reqUser = decoded.slice(0, sepIndex);
      const reqPass = decoded.slice(sepIndex + 1);
      // So sánh hằng thời gian: tránh kẻ tấn công đo thời gian phản hồi để đoán password
      const userMatch = timingSafeStringEqual(reqUser, user);
      const passMatch = timingSafeStringEqual(reqPass, pass);
      if (userMatch && passMatch) {
        return NextResponse.next();
      }
    }
  }

  return new NextResponse('Yêu cầu đăng nhập.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="ZippyDrive", charset="UTF-8"' },
  });
}

// Áp dụng cho mọi route TRỪ các asset tĩnh Next.js tự sinh, để không làm chậm/vỡ
// việc load font, favicon...
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
