import { NextRequest } from 'next/server';
import { getProgress } from '@/lib/progress-store';

export const runtime = 'nodejs';

/** Server-Sent Events: đẩy tiến độ tải zip theo thời gian thực cho client, dựa
 * trên `token` do client tự sinh và gắn kèm khi gọi `/api/download?...&token=...`.
 * Đây là kênh RIÊNG, chỉ để BÁO tiến độ — file zip thật vẫn được trình duyệt tải
 * qua request GET gốc tới `/api/download` (native download, ghi thẳng ra đĩa). */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token) return new Response('Thiếu token.', { status: 400 });

  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval>;
  let heartbeat: ReturnType<typeof setInterval>;

  const stream = new ReadableStream({
    start(controller) {
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
          // Chưa có / đã dọn (hết hạn) — vẫn báo cho client biết thay vì im lặng
          send({ status: 'unknown' });
          return;
        }
        send(p);
        if (p.status === 'done' || p.status === 'error') {
          clearInterval(interval);
          clearInterval(heartbeat);
          try { controller.close(); } catch { /* đã đóng rồi */ }
        }
      }, 500);

      // Heartbeat mỗi 15s: gửi comment SSE để proxy/load balancer không đóng kết nối
      // idle trước khi tiến độ thực sự có gì mới (đặc biệt khi đang xếp hàng chờ).
      heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(': heartbeat\n\n')); } catch { /* closed */ }
      }, 15_000);

      req.signal.addEventListener('abort', () => {
        clearInterval(interval);
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* đã đóng rồi */ }
      });
    },
    cancel() {
      clearInterval(interval);
      clearInterval(heartbeat);
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
