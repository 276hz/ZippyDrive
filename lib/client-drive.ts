/**
 * Tải file trực tiếp Browser ↔ Google Drive — KHÔNG qua Render.
 *
 * Đây là Architecture C (đã bàn kỹ và verify bằng PoC độc lập, không phải suy đoán):
 *   - CORS: PASS thật trên googleapis.com với pattern fetch({mode:'cors'}) + ?key=
 *   - Redirect: không phát hiện hop sang host khác cho pattern này
 *   - Range/resume: an toàn byte-for-byte kể cả resume giữa file, dù response gzip
 *   - Content-Disposition: server Google CHỈ trả "attachment", KHÔNG có filename=
 *     → bắt buộc tự đặt tên file ở client (từ /api/list), không dựa header Google
 *
 * GIỚI HẠN ĐÃ BIẾT (không phải bug, là đặc điểm của cơ chế này):
 *   - <a download="..."> KHÔNG đáng tin cậy với URL cross-origin (Firefox bỏ qua
 *     hoàn toàn, Chrome bỏ filename hint) → bắt buộc fetch() rồi bọc lại thành
 *     blob: URL (được xem là same-origin theo spec) trước khi trigger download.
 *   - Vì phải fetch() trước, ĐÂY VẪN PHỤ THUỘC CORS — không phải cơ chế
 *     "CORS-independent" như đánh giá ban đầu (đã tự đính chính khi phát hiện).
 *   - Không giữ được cấu trúc thư mục con thật: browser thay "/" bằng "_" trong
 *     tên file khi lưu (khác Architecture A vốn giữ cấu trúc trong file .zip).
 *   - Ra N file rời trong Downloads, không phải 1 file .zip duy nhất.
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

export interface DirectDownloadFile {
  id: string;
  /** path tương đối như "/api/list" trả về, ví dụ "sub/folder/ten-file.pdf" */
  path: string;
  mimeType: string;
  size: number | null;
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

/** "sub/folder/ten-file.pdf" → "sub_folder_ten-file.pdf" — browser tự làm vậy
 * với <a download> dù mình muốn hay không (xem PoC), nên chủ động làm trước để
 * tên hiển thị lúc tải và tên file lưu ra khớp nhau, không bất ngờ. */
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
  resourceKey?: string | null,
  signal?: AbortSignal
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const url = buildMediaUrl(file.id, resourceKey);
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
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Lỗi không xác định.' };
  }
}

/** Tải tuần tự toàn bộ danh sách file. Cố ý KHÔNG song song nhiều file cùng lúc
 * ở bản này — trình duyệt có thể hỏi permission/chặn nếu nhiều download tự
 * động bắn ra cùng lúc; tăng concurrency là việc của bản sau, cần test riêng. */
export async function downloadFolderDirect(
  files: DirectDownloadFile[],
  resourceKey: string | null | undefined,
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
    const result = await downloadFileDirect(f, resourceKey, signal);
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
