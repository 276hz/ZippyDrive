import { NextRequest, NextResponse } from 'next/server';

/**
 * So sánh hằng thời gian (constant-time) thuần JavaScript — không dùng
 * `===` hay so sánh chuỗi/mảng byte thông thường (kể cả `Buffer.equals()`,
 * vốn hoạt động giống `memcmp` chuẩn và có thể dừng ngay khi gặp byte đầu
 * tiên khác nhau), vì vẫn lộ thời gian phản hồi theo độ dài phần trùng khớp.
 * Middleware chạy trên Edge Runtime theo mặc định (không khai báo
 * `runtime: 'nodejs'` bên dưới) nên toàn bộ file này chỉ dùng API chuẩn Web
 * (atob, TextDecoder) — không phụ thuộc Buffer hay module `crypto` của
 * Node.js, vốn là API riêng của Node và không có gì đảm bảo tồn tại trên mọi
 * middleware runtime. Hàm dưới đây luôn duyệt hết độ dài lớn nhất của 2
 * chuỗi bằng XOR tích luỹ, không rẽ nhánh sớm theo nội dung.
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
    // Tách scheme/payload bằng khoảng trắng ĐẦU TIÊN thay vì split(' '): một
    // khoảng trắng thừa trong header (ví dụ proxy/client chèn thêm) sẽ khiến
    // split(' ') trả về mảng lệch vị trí, làm payload base64 bị rỗng sai.
    const spaceIdx = authHeader.indexOf(' ');
    const scheme = spaceIdx === -1 ? authHeader : authHeader.slice(0, spaceIdx);
    const encoded = spaceIdx === -1 ? '' : authHeader.slice(spaceIdx + 1).trim();

    if (scheme === 'Basic' && encoded) {
      try {
        // atob() + TextDecoder — API chuẩn Web, được Edge Runtime đảm bảo hỗ trợ
        // theo đặc tả (khác Buffer, vốn là API riêng của Node.js và không có gì
        // đảm bảo tồn tại trên mọi runtime middleware chạy). atob() ném lỗi nếu
        // payload base64 không hợp lệ — bắt lại để trả 401 sạch thay vì crash.
        const binary = atob(encoded);
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        const decoded = new TextDecoder('utf-8').decode(bytes);

        const sepIndex = decoded.indexOf(':');
        if (sepIndex !== -1) {
          const reqUser = decoded.slice(0, sepIndex);
          const reqPass = decoded.slice(sepIndex + 1);
          // So sánh hằng thời gian: tránh kẻ tấn công đo thời gian phản hồi để đoán password
          if (timingSafeStringEqual(reqUser, user) && timingSafeStringEqual(reqPass, pass)) {
            return NextResponse.next();
          }
        }
      } catch {
        // Base64 hỏng/không decode được UTF-8 hợp lệ -> coi như auth thất bại, rơi
        // xuống trả 401 phía dưới, không để lỗi rò rỉ ra ngoài dưới dạng 500.
      }
    }
  }

  return new NextResponse('Yêu cầu đăng nhập.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="ZippyDrive", charset="UTF-8"' },
  });
}

// Áp dụng cho mọi route TRỪ các asset tĩnh Next.js tự sinh, để không làm chậm/vỡ
// việc load font, favicon... (icon.svg là path THẬT SỰ Next.js serve app/icon.svg
// ra — đã xác minh qua build output, KHÔNG phải favicon.ico như quy ước cũ).
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
