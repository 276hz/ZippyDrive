/**
 * Tải file trực tiếp Browser ↔ Google Drive — KHÔNG qua server (Architecture C).
 *
 * Luồng thực tế: Google Drive API (CORS, `mode:'cors'` + `?key=`) → Response →
 * Blob → Object URL (`blob:`) → trigger download qua thẻ `<a>`. Đây KHÔNG phải
 * ghi trực tiếp ra đĩa qua tầng mạng hệ điều hành như native download — toàn bộ
 * nội dung file đi qua bộ nhớ trình duyệt dưới dạng Blob trước khi được lưu, vì:
 *   - `<a download="...">` không đáng tin cậy với URL cross-origin (một số trình
 *     duyệt bỏ qua hoàn toàn hoặc bỏ filename hint), nên bắt buộc fetch() trước
 *     rồi bọc lại thành `blob:` URL (same-origin theo spec) để trigger download
 *     kèm đúng tên file.
 *   - Máy chủ Google trả `Content-Disposition: attachment` không kèm filename,
 *     nên tên file hiển thị lúc tải phải tự đặt ở client (từ dữ liệu `/api/list`).
 *
 * Giới hạn đã biết (đặc điểm của cơ chế, không phải bug):
 *   - Không giữ được cấu trúc thư mục con thật: browser thay "/" bằng "_" trong
 *     tên file khi lưu (khác Architecture A vốn giữ cấu trúc trong file .zip).
 *   - Ra N file rời trong Downloads, không phải 1 file .zip duy nhất.
 *   - Toàn bộ nội dung file nằm trong RAM trình duyệt (dưới dạng Blob) trong lúc
 *     tải — phù hợp với file đơn lẻ cỡ vừa/nhỏ, không phù hợp để thay thế
 *     Architecture A cho file cực lớn.
 *
 * BẮT BUỘC trước khi bật tính năng này ở production:
 *   1. Tạo 1 API key RIÊNG trong Google Cloud Console — KHÔNG dùng chung với
 *      GOOGLE_API_KEY phía server.
 *   2. Application restrictions → HTTP referrers → đúng domain production.
 *   3. API restrictions → chỉ Google Drive API.
 *   4. Set vào NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT (biến này SẼ nằm trong bundle
 *      JS gửi cho browser — đó là chủ đích, không phải rò rỉ. Không nhầm với
 *      GOOGLE_API_KEY.)
 */

import { errorMessage } from './errors.ts';

export interface DirectDownloadFile {
  id: string;
  /** path tương đối như "/api/list" trả về, ví dụ "sub/folder/ten-file.pdf" */
  path: string;
  mimeType: string;
  size: number | null;
  /** resourceKey CỦA CHÍNH FILE NÀY (Drive API v3 trả riêng cho từng item, không
   * kế thừa từ folder cha) — xem lib/drive.ts để biết vì sao không dùng chung 1
   * giá trị cho cả folder. */
  resourceKey?: string | null;
}

export interface DirectDownloadProgress {
  totalFiles: number;
  completedFiles: number;
  currentFileName: string | null;
  skipped: { name: string; reason: string }[];
  status: 'running' | 'done';
}

/** True nếu client key đã được cấu hình — dùng để feature-detect, ẩn hoàn toàn
 * nút "Tải trực tiếp" nếu chưa setup, tự động fallback về Architecture A. */
export function directDownloadEnabled(): boolean {
  return !!process.env.NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT;
}

export function buildMediaUrl(fileId: string, resourceKey?: string | null): string {
  const clientKey = process.env.NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT;
  if (!clientKey) {
    throw new Error('NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT chưa được cấu hình ở server.');
  }
  const params = new URLSearchParams({ alt: 'media', key: clientKey });
  if (resourceKey) params.set('resourceKey', resourceKey);
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`;
}

/** "sub/folder/ten-file.pdf" → "sub_folder_ten-file.pdf" — trình duyệt tự thay
 * "/" bằng "_" khi lưu qua thẻ <a download> (không thể chỉnh cấu trúc thư mục
 * qua cơ chế này), nên chủ động làm trước để tên hiển thị lúc tải và tên file
 * lưu ra khớp nhau, không bất ngờ. */
function flattenName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts.join('_') : path;
}

export async function fetchWithRetry(url: string, attempts = 3, signal?: AbortSignal): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { mode: 'cors', signal });
      if (res.ok) return res;
      // Lỗi nghiệp vụ (file private, đã xoá, là Google Docs cần export...) —
      // không nên retry, thử lại cũng ra kết quả y hệt.
      if (res.status >= 400 && res.status < 500) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      // Huỷ chủ động (AbortError) không phải lỗi mạng chập chờn — không retry,
      // ném ngay để vòng lặp gọi hàm này dừng lại tức thì thay vì đợi backoff.
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      lastErr = e;
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, i) + Math.random() * 200));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Không tải được sau nhiều lần thử.');
}

/** Tải 1 file trực tiếp Google → browser, trigger lưu qua blob: URL. */
export async function downloadFileDirect(
  file: DirectDownloadFile,
  signal?: AbortSignal
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const url = buildMediaUrl(file.id, file.resourceKey);
    const res = await fetchWithRetry(url, 3, signal);
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.clone().text();
        const parsed = JSON.parse(body);
        if (parsed?.error?.message) detail = parsed.error.message;
      } catch {
        // body không phải JSON hoặc rỗng — giữ nguyên detail mặc định
      }
      return { ok: false, error: detail };
    }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = flattenName(file.path);
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Trì hoãn revoke để trình duyệt kịp bắt đầu ghi file trước khi blob giải phóng.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: errorMessage(e, 'Lỗi không xác định.') };
  }
}

/** Tải tuần tự toàn bộ danh sách file — cố ý KHÔNG song song nhiều file cùng
 * lúc, vì trình duyệt có thể hỏi permission hoặc chặn hoàn toàn nếu nhiều
 * download tự động bắn ra đồng thời (đặc điểm bảo mật của trình duyệt, không
 * phải giới hạn có thể tắt/chỉnh qua code). */
export async function downloadFolderDirect(
  files: DirectDownloadFile[],
  onProgress: (p: DirectDownloadProgress) => void,
  signal?: AbortSignal
): Promise<{ cancelled: boolean }> {
  const skipped: { name: string; reason: string }[] = [];
  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) return { cancelled: true };
    const f = files[i];
    onProgress({
      totalFiles: files.length,
      completedFiles: i,
      currentFileName: f.path,
      skipped: [...skipped],
      status: 'running',
    });
    const result = await downloadFileDirect(f, signal);
    if (!result.ok) {
      skipped.push({ name: f.path, reason: result.error });
    }
    // Giãn nhẹ để trình duyệt xử lý kịp download vừa trigger trước khi bắn cái tiếp theo.
    await new Promise((r) => setTimeout(r, 150));
  }
  onProgress({
    totalFiles: files.length,
    completedFiles: files.length,
    currentFileName: null,
    skipped,
    status: 'done',
  });
  return { cancelled: false };
}
