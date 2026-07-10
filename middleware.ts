import { NextRequest, NextResponse } from 'next/server';

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
      if (reqUser === user && reqPass === pass) {
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
