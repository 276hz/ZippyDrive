import { NextRequest } from 'next/server';
import { buildDownloadRequest, contentDisposition, fetchWithRetry, isDriveId } from '@/lib/drive';
import { createLimiter } from '@/lib/limiter';
import { errorMessage } from '@/lib/errors';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Tối đa 8 luồng proxy đồng thời trên toàn server. Route này (tải 1 file đơn lẻ) không đi
// qua hàng đợi tải zip nên cần trần riêng — nếu không, ai cũng mở được hàng trăm luồng song
// song và nuốt hết băng thông/CPU của server nhỏ. Đầy thì 429 + Retry-After, KHÔNG xếp hàng.
const proxyLimiter = createLimiter(8);

// type/subtype theo RFC 6838 — đủ rộng cho mọi mimeType Drive trả về, chặn mọi thứ khác.
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
const RESOURCE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

const bad = (message: string, status = 400) => new Response(message, { status });

/** Bọc luồng từ Google để TRẢ chỗ (`leave`) đúng lúc luồng kết thúc — dù do tải xong, lỗi giữa
 * chừng hay client huỷ (cancel). Không làm vậy thì chỗ chỉ được trả khi route trả Response,
 * tức là quá sớm: luồng vẫn đang chạy nên trần đồng thời không còn đúng nghĩa. */
function releaseWhenDone(body: ReadableStream<Uint8Array>, leave: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          leave();
        } else {
          controller.enqueue(value);
        }
      } catch (e) {
        controller.error(e);
        leave();
      }
    },
    cancel(reason) {
      leave();
      return reader.cancel(reason);
    },
  });
}

// Proxy 1 file duy nhất mỗi lần gọi (trường hợp link dán vào là 1 file đơn lẻ,
// không phải folder). Stream trực tiếp, không buffer trong bộ nhớ server.
export async function GET(req: NextRequest) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return bad('Server chưa cấu hình GOOGLE_API_KEY.', 500);
  }

  const id = req.nextUrl.searchParams.get('id');
  const mime = req.nextUrl.searchParams.get('mime') ?? '';
  const name = (req.nextUrl.searchParams.get('name') ?? 'file').slice(0, 255);
  const resourceKey = req.nextUrl.searchParams.get('key') ?? undefined;

  if (!id) return bad('Thiếu tham số id.');

  // BẮT BUỘC kiểm tra: `id` đi thẳng vào URL path tới www.googleapis.com cùng API key của
  // server. Trước đây `id=../../../youtube/v3/search?q=x` khiến server gọi endpoint đó (dùng
  // key của bạn) rồi trả kết quả cho người gọi — tức là một proxy mở đốt quota/băng thông.
  if (!isDriveId(id)) return bad('ID file không hợp lệ.');
  if (mime !== '' && !MIME_PATTERN.test(mime)) return bad('mimeType không hợp lệ.');
  if (resourceKey !== undefined && !RESOURCE_KEY_PATTERN.test(resourceKey)) return bad('resourceKey không hợp lệ.');

  const request = buildDownloadRequest(id, mime, apiKey, resourceKey);
  if (!request) {
    return bad(`Loại file "${mime}" không hỗ trợ tải xuống trực tiếp.`, 415);
  }

  const leave = proxyLimiter.tryEnter();
  if (!leave) {
    return new Response('Server đang bận tải file cho nhiều người. Vui lòng thử lại sau ít giây.', {
      status: 429,
      headers: { 'Retry-After': '5' },
    });
  }

  let upstream: Response;
  try {
    // Cùng cơ chế retry với route tải zip folder — lỗi mạng/429/5xx tạm thời sẽ tự
    // thử lại thay vì bắt người dùng bấm tải lại từ đầu. Truyền req.signal để nếu
    // client đóng kết nối ngay trong lúc đang fetch/retry, dừng ngay thay vì tiếp
    // tục kéo dữ liệu từ Google một cách lãng phí.
    upstream = await fetchWithRetry(
      request.url.toString(),
      request.headers ? { headers: request.headers } : undefined,
      3,
      req.signal ?? undefined
    );
  } catch (e: unknown) {
    leave();
    return bad(`Lỗi kết nối Google Drive: ${errorMessage(e, 'không xác định')}`, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    leave();
    return new Response(`Google Drive trả lỗi ${upstream.status}. ${detail.slice(0, 200)}`, {
      status: 502,
    });
  }

  // Không còn `Access-Control-Allow-Origin: *`: UI gọi cùng origin nên không cần CORS, còn
  // header đó cho phép JavaScript của BẤT KỲ website nào đọc nội dung đi qua server của bạn.
  return new Response(releaseWhenDone(upstream.body, leave), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition(name),
      'Cache-Control': 'no-store',
    },
  });
}
