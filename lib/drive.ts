export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  path: string; // đường dẫn tương đối bên trong file zip (giữ cấu trúc thư mục)
}

export interface ParsedDriveLink {
  type: 'folder' | 'file';
  id: string;
  resourceKey?: string;
}

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const ID_PATTERN = '[a-zA-Z0-9_-]{10,}';

// Các định dạng "native" của Google (Docs/Sheets/Slides...) không tải trực tiếp được,
// phải export sang định dạng phổ biến tương ứng.
export const GOOGLE_EXPORT_MAP: Record<string, { mimeType: string; ext: string }> = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: '.docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ext: '.pptx',
  },
  'application/vnd.google-apps.drawing': {
    mimeType: 'image/png',
    ext: '.png',
  },
};

/**
 * Nhận diện link Google Drive (folder / file) và trích xuất ID + resourceKey (nếu có).
 *
 * Dùng `URL`/`URLSearchParams` chuẩn của nền tảng thay vì regex trên chuỗi thô, nên
 * hoạt động đúng với MỌI biến thể link Google Drive từng ghi nhận, bất kể query string
 * đi kèm là gì — ví dụ: `?usp=sharing`, `?usp=drive_link`, `&ths=true`, hay link rút gọn
 * từ ứng dụng di động (`/drive/u/0/mobile/folders/...`).
 *
 * `resourceKey` là tham số bảo mật Google gắn thêm cho một số link chia sẻ (theo chính
 * sách từ 2021) — nếu có mà bỏ qua, Google Drive API sẽ trả lỗi 404 dù link vẫn mở được
 * bình thường trên trình duyệt. Được truyền tiếp vào header `X-Goog-Drive-Resource-Keys`
 * khi gọi API để đảm bảo truy cập đúng.
 */
export function parseDriveUrl(raw: string): ParsedDriveLink {
  // Loại bỏ khoảng trắng thừa và các ký tự ẩn (zero-width) hay dính khi copy từ ứng dụng di động
  const cleaned = raw.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');

  let pathname = cleaned;
  let search = '';
  try {
    const asUrl = new URL(cleaned);
    pathname = asUrl.pathname;
    search = asUrl.search;
  } catch {
    // Không phải URL hợp lệ — có thể người dùng dán thẳng ID, xử lý ở nhánh cuối
  }
  const resourceKey = new URLSearchParams(search).get('resourcekey') ?? undefined;

  let m = pathname.match(new RegExp(`/folders/(${ID_PATTERN})`));
  if (m) return { type: 'folder', id: m[1], resourceKey };

  m = pathname.match(new RegExp(`/file/d/(${ID_PATTERN})`));
  if (m) return { type: 'file', id: m[1], resourceKey };

  m = cleaned.match(new RegExp(`[?&]id=(${ID_PATTERN})`));
  if (m) return { type: 'file', id: m[1], resourceKey };

  // Người dùng dán thẳng ID (không phải URL)
  if (new RegExp(`^${ID_PATTERN}$`).test(cleaned)) {
    return { type: 'folder', id: cleaned };
  }

  throw new Error(
    'Không nhận diện được link Google Drive. Hãy dán link folder (drive.google.com/drive/folders/...) hoặc file (drive.google.com/file/d/...), và đảm bảo đã bật chia sẻ "Anyone with the link".'
  );
}

export function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled';
}

/** Header chuẩn của Google cho các link có gắn resourceKey bảo mật */
function resourceKeyHeaders(id: string, resourceKey?: string): HeadersInit | undefined {
  if (!resourceKey) return undefined;
  return { 'X-Goog-Drive-Resource-Keys': `${id}/${resourceKey}` };
}

async function driveFetch(
  path: string,
  apiKey: string,
  params: Record<string, string> = {},
  headers?: HeadersInit
) {
  const url = new URL(`${DRIVE_API}${path}`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('supportsAllDrives', 'true');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), headers ? { headers } : undefined);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let hint = '';
    if (res.status === 404) hint = ' File/folder không tồn tại hoặc chưa được share public.';
    if (res.status === 403) hint = ' Có thể API key sai, chưa bật Drive API, hoặc file bị chặn tải xuống.';
    throw new Error(`Google Drive API lỗi ${res.status}.${hint} (${body.slice(0, 150)})`);
  }
  return res.json();
}

export async function getFileMeta(fileId: string, apiKey: string, resourceKey?: string) {
  return driveFetch(
    `/files/${fileId}`,
    apiKey,
    { fields: 'id,name,mimeType,size' },
    resourceKeyHeaders(fileId, resourceKey)
  );
}

/** Duyệt đệ quy toàn bộ folder, trả về danh sách phẳng các file (đã bỏ qua sub-folder) */
export async function listFolderRecursive(
  folderId: string,
  apiKey: string,
  basePath = '',
  resourceKey?: string
): Promise<DriveFile[]> {
  const results: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const data: any = await driveFetch(
      '/files',
      apiKey,
      {
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size)',
        pageSize: '1000',
        includeItemsFromAllDrives: 'true',
        ...(pageToken ? { pageToken } : {}),
      },
      resourceKeyHeaders(folderId, resourceKey)
    );

    for (const file of data.files ?? []) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        // resourceKey chỉ áp dụng cho ID gốc được chia sẻ trực tiếp, thư mục con kế thừa quyền bình thường
        const sub = await listFolderRecursive(file.id, apiKey, `${basePath}${sanitize(file.name)}/`);
        results.push(...sub);
      } else {
        results.push({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          path: `${basePath}${sanitize(file.name)}`,
        });
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return results;
}

/** Xây URL + header để tải nội dung thật của 1 file */
export function buildDownloadRequest(
  fileId: string,
  mimeType: string,
  apiKey: string,
  resourceKey?: string
): { url: URL; headers?: HeadersInit } | null {
  const exportInfo = GOOGLE_EXPORT_MAP[mimeType];
  if (exportInfo) {
    const url = new URL(`${DRIVE_API}/files/${fileId}/export`);
    url.searchParams.set('mimeType', exportInfo.mimeType);
    url.searchParams.set('key', apiKey);
    return { url, headers: resourceKeyHeaders(fileId, resourceKey) };
  }
  if (mimeType.startsWith('application/vnd.google-apps')) {
    // Loại native không export được (Forms, Sites, Maps, Jamboard...)
    return null;
  }
  const url = new URL(`${DRIVE_API}/files/${fileId}`);
  url.searchParams.set('alt', 'media');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('key', apiKey);
  return { url, headers: resourceKeyHeaders(fileId, resourceKey) };
}

export function finalExtName(path: string, mimeType: string): string {
  const exportInfo = GOOGLE_EXPORT_MAP[mimeType];
  if (!exportInfo) return path;
  const hasExt = /\.[^./]+$/.test(path);
  return hasExt ? path.replace(/\.[^./]+$/, exportInfo.ext) : path + exportInfo.ext;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  // Exponential backoff + jitter nhỏ: 1s, 2s, 4s... (trần 8s), cộng thêm ngẫu nhiên
  // 0-300ms để tránh nhiều request retry cùng lúc dồn vào Google cùng 1 thời điểm.
  return Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.random() * 300;
}

/**
 * fetch() có tự động thử lại tối đa `maxAttempts` lần khi gặp lỗi TẠM THỜI:
 * - Lỗi mạng (mất kết nối, DNS, timeout...) ném exception → bắt và thử lại.
 * - HTTP 429 (rate limit) hoặc 5xx (lỗi phía Google) → thử lại.
 * Lỗi 4xx khác (403 permission, 404 not found...) KHÔNG retry vì thử lại cũng
 * không đổi kết quả, chỉ tốn thời gian.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit | undefined,
  maxAttempts = 3
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Lỗi mạng không xác định.');
}

export function sumKnownSizes(files: { size?: string }[]): number {
  return files.reduce((sum, f) => sum + (f.size ? Number(f.size) : 0), 0);
}

/** Giới hạn tổng dung lượng cho phép tải — MẶC ĐỊNH LÀ KHÔNG GIỚI HẠN (null).
 * Lý do an toàn để không giới hạn: kiến trúc streaming hiện tại xử lý TỪNG FILE
 * MỘT (đã fix ở bước trước), không giữ cả file trong RAM, nên bản thân dung
 * lượng file/folder lớn tới đâu KHÔNG gây tràn RAM nữa — giới hạn cũ chỉ là lớp
 * phòng hờ, không phải điều kiện bắt buộc.
 *
 * Rủi ro còn lại khi tải folder cực lớn (không phải lỗi code, mà là giới hạn vật
 * lý của gói free): tốc độ mạng/CPU của Render free bị giới hạn nên folder hàng
 * chục/trăm GB có thể mất nhiều giờ; và KHÔNG có tính năng "tải tiếp" (resume) —
 * nếu mất mạng giữa chừng phải tải lại từ đầu. Nếu muốn giới hạn lại, set env
 * `MAX_TOTAL_DOWNLOAD_BYTES` (ví dụ 5368709120 = 5GB) trên Render. */
export function maxTotalDownloadBytes(): number | null {
  const fromEnv = Number(process.env.MAX_TOTAL_DOWNLOAD_BYTES);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : null;
}

/** Header Content-Disposition chuẩn RFC 5987/6266: kèm cả `filename` (ASCII, để tương
 * thích trình duyệt/thư viện cũ) lẫn `filename*` (UTF-8, để giữ đúng tên tiếng Việt,
 * tiếng Trung... trên mọi trình duyệt hiện đại).
 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  const encoded = encodeURIComponent(filename).replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
