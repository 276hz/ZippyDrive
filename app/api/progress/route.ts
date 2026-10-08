import { NextRequest } from 'next/server';
import { getProgress, isValidToken } from '@/lib/progress-store';
import { createLimiter } from '@/lib/limiter';

export const runtime = 'nodejs';

// Mỗi luồng SSE giữ 2 timer + 1 kết nối. Không giới hạn thì mở vài nghìn luồng là nghẽn
// server nhỏ — đầy thì từ chối (client tự thử lại sau).
const sseLimiter = createLimiter(100);

// Token KHÔNG có phiên tương ứng liên tục quá ngần này thời gian → báo lỗi rồi đóng luồng.
// Trước đây route gửi `{"status":"unknown"}` vô hạn mỗi 500ms cho tới khi client tự ngắt.
// 60 giây là dư cho khoảng trễ bình thường giữa lúc mở SSE và lúc /api/download tạo phiên.
const UNKNOWN_GRACE_MS = 60_000;

/** Server-Sent Events: đẩy tiến độ tải zip theo thời gian thực cho client, dựa
 * trên `token` do client tự sinh và gắn kèm khi gọi `/api/download?...&token=...`.
 * Đây là kênh RIÊNG, chỉ để BÁO tiến độ — file zip thật vẫn được trình duyệt tải
 * qua request GET gốc tới `/api/download` (native download, ghi thẳng ra đĩa). */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token) return new Response('Thiếu token.', { status: 400 });
  if (!isValidToken(token)) return new Response('Token không hợp lệ.', { status: 400 });

  const leave = sseLimiter.tryEnter();
  if (!leave) {
    return new Response('Quá nhiều luồng theo dõi tiến độ đang mở. Vui lòng thử lại sau.', {
      status: 503,
      headers: { 'Retry-After': '5' },
    });
  }

  const encoder = new TextEncoder();
  // Một chỗ DUY NHẤT dọn mọi thứ (timer, chỗ trong limiter, đóng stream) — gọi từ mọi đường
  // kết thúc: xong/lỗi, client ngắt, cancel, hết hạn token.
  let shutdown: () => void = leave;

  const stream = new ReadableStream({
    start(controller) {
      let interval: ReturnType<typeof setInterval> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let closed = false;
      let unknownSince: number | null = null;

      shutdown = () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        clearInterval(heartbeat);
        leave();
        try {
          controller.close();
        } catch {
          /* đã đóng rồi */
        }
      };

      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // controller đã đóng (client ngắt kết nối) — bỏ qua
        }
      };

      interval = setInterval(() => {
        const p = getProgress(token);
        if (!p) {
          // Chưa có / đã dọn (hết hạn). Client bỏ qua thông điệp "unknown" (đang chờ phiên được
          // tạo); nhưng nếu kéo dài quá hạn thì báo lỗi rõ ràng và đóng luồng thay vì im lặng mãi.
          const now = Date.now();
          unknownSince ??= now;
          if (now - unknownSince > UNKNOWN_GRACE_MS) {
            send({
              totalFiles: 0,
              completedFiles: 0,
              currentFileName: null,
              skipped: [],
              status: 'error',
              errorMessage: 'Không tìm thấy phiên tải (chưa bắt đầu hoặc đã hết hạn). Hãy bấm tải lại.',
              startedAt: now,
              updatedAt: now,
            });
            shutdown();
            return;
          }
          send({ status: 'unknown' });
          return;
        }
        unknownSince = null;
        send(p);
        if (p.status === 'done' || p.status === 'error') shutdown();
      }, 500);

      // Heartbeat mỗi 15s: gửi comment SSE để proxy/load balancer không đóng kết nối
      // idle trước khi tiến độ thực sự có gì mới (đặc biệt khi đang xếp hàng chờ).
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          /* closed */
        }
      }, 15_000);

      if (req.signal.aborted) shutdown();
      else req.signal.addEventListener('abort', shutdown, { once: true });
    },
    cancel() {
      shutdown();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // tắt buffer ở reverse proxy (nginx...) nếu Render dùng, đảm bảo SSE đẩy tức thời
    },
  });
}
