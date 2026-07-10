import { NextRequest } from 'next/server';
import { buildDownloadRequest, contentDisposition, fetchWithRetry } from '@/lib/drive';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Proxy 1 file duy nhất mỗi lần gọi (trường hợp link dán vào là 1 file đơn lẻ,
// không phải folder). Stream trực tiếp, không buffer trong bộ nhớ server.
export async function GET(req: NextRequest) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return new Response('Server chưa cấu hình GOOGLE_API_KEY.', { status: 500 });
  }

  const id = req.nextUrl.searchParams.get('id');
  const mime = req.nextUrl.searchParams.get('mime') ?? '';
  const name = req.nextUrl.searchParams.get('name') ?? 'file';
  const resourceKey = req.nextUrl.searchParams.get('key') ?? undefined;

  if (!id) return new Response('Thiếu tham số id.', { status: 400 });

  const request = buildDownloadRequest(id, mime, apiKey, resourceKey);
  if (!request) {
    return new Response(`Loại file "${mime}" không hỗ trợ tải xuống trực tiếp.`, { status: 415 });
  }

  let upstream: Response;
  try {
    // Cùng cơ chế retry với route tải zip folder — lỗi mạng/429/5xx tạm thời sẽ tự
    // thử lại thay vì bắt người dùng bấm tải lại từ đầu.
    upstream = await fetchWithRetry(request.url.toString(), request.headers ? { headers: request.headers } : undefined);
  } catch (e: any) {
    return new Response(`Lỗi kết nối Google Drive: ${e?.message ?? e}`, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return new Response(`Google Drive trả lỗi ${upstream.status}. ${detail.slice(0, 200)}`, {
      status: 502,
    });
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition(name),
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
