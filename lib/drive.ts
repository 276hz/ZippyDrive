export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  path: string; // đường dẫn tương đối bên trong file zip (giữ cấu trúc thư mục)
  /** resourceKey CỦA CHÍNH FILE/FOLDER NÀY — lấy từ field `resourceKey` mà Google
   * Drive API v3 trả về cho từng item trong response `files.list`/`files.get`.
   * KHÔNG được giả định file con dùng resourceKey của folder cha: đây là thuộc
   * tính riêng của từng resource, Google trả về output field này độc lập cho
   * mỗi item khi item đó cần resourceKey để truy cập. */
  resourceKey?: string;
}

export interface ParsedDriveLink {
  type: 'folder' | 'file';
  id: string;
  resourceKey?: string;
}

/** Các field thực sự dùng từ response Drive API — KHÔNG map toàn bộ schema
 * (Drive API trả về rất nhiều field không liên quan), chỉ định nghĩa đúng phần
 * `fields=...` mà code này request và đọc. */
interface DriveApiFileMeta {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  resourceKey?: string;
}

interface DriveApiListResponse {
  nextPageToken?: string;
  files?: DriveApiFileMeta[];
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
  // Loại bỏ khoảng trắng thừa (kể cả nội bộ — copy dán đôi khi dính xuống dòng
  // giữa chuỗi) và các ký tự ẩn (zero-width) hay dính khi copy từ ứng dụng di động.
  const cleaned = raw.trim().replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '');

  const notDriveUrlError = () =>
    new Error(
      'Không nhận diện được link Google Drive. Hãy dán link folder (drive.google.com/drive/folders/...) hoặc file (drive.google.com/file/d/...), và đảm bảo đã bật chia sẻ "Anyone with the link".'
    );

  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(cleaned);
  } catch {
    parsedUrl = null; // Không phải URL hợp lệ — có thể người dùng dán thẳng ID, xử lý ở nhánh cuối.
  }

  if (parsedUrl) {
    // Là URL hợp lệ nhưng không đúng domain Google Drive — từ chối NGAY, không
    // thử khớp pattern /folders/ hay /file/d/ trên chuỗi gốc nữa. Nếu không chặn
    // ở đây, domain giả dạng "drive.google.com.evil.com" (path vẫn chứa
    // "/folders/xxxxxxxxxx") sẽ lọt qua các kiểm tra fallback bên dưới dù domain
    // sai — CHÍNH XÁC là kiểu URL giả mạo cần chặn. So khớp hostname CHÍNH XÁC,
    // không dùng "chứa"/"kết thúc bằng", vì cả hai đều bị qua mặt bởi domain
    // lookalike kiểu trên.
    if (parsedUrl.hostname !== 'drive.google.com') {
      throw notDriveUrlError();
    }

    const pathname = parsedUrl.pathname;
    const search = parsedUrl.search;
    const resourceKey = new URLSearchParams(search).get('resourcekey') ?? undefined;

    let m = pathname.match(new RegExp(`/folders/(${ID_PATTERN})`));
    if (m) return { type: 'folder', id: m[1], resourceKey };

    m = pathname.match(new RegExp(`/file/d/(${ID_PATTERN})`));
    if (m) return { type: 'file', id: m[1], resourceKey };

    m = search.match(new RegExp(`[?&]id=(${ID_PATTERN})`));
    if (m) return { type: 'file', id: m[1], resourceKey };

    // Đúng domain Drive nhưng không khớp dạng path nào đã biết (vd. link
    // Google Forms/Sites/Maps trên cùng domain, hoặc trang chủ Drive).
    throw notDriveUrlError();
  }

  // Không phải URL — chỉ chấp nhận nếu là một ID trần hợp lệ (đúng độ dài, đúng
  // bảng ký tự Drive dùng). KHÔNG nới lỏng thành "trông giống ID" chung chung,
  // để tránh chấp nhận nhầm chuỗi bất kỳ không liên quan tới Google Drive.
  if (new RegExp(`^${ID_PATTERN}$`).test(cleaned)) {
    return { type: 'folder', id: cleaned };
  }

  throw notDriveUrlError();
}

const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/** Làm sạch MỘT thành phần tên (file hoặc folder) để dùng an toàn làm path
 * segment — cả trong tên file zip lẫn entry name bên trong zip. Không chỉ thay
 * ký tự Windows cấm; còn phải chặn các trường hợp không chứa ký tự cấm nào
 * nhưng vẫn nguy hiểm hoặc gây lỗi khi extract:
 *   - "." hoặc ".." dùng nguyên component → path traversal khi giải nén zip
 *     (không đi qua bất kỳ ký tự nào trong danh sách cấm, nên nếu chỉ lọc ký
 *     tự thì lọt qua hoàn toàn).
 *   - tên thiết bị dành riêng của Windows (CON, PRN, NUL, COM1..9, LPT1..9) —
 *     tạo file/folder trùng tên này trên Windows có thể lỗi hoặc hành xử khác
 *     ý muốn, kể cả khi có phần mở rộng (ví dụ "con.txt").
 *   - dấu chấm/khoảng trắng ở cuối tên — Windows Explorer tự strip khi tạo
 *     file, khiến tên sau khi giải nén khác với tên gốc trong zip.
 */
export function sanitize(name: string): string {
  let cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\\/:*?"<>|]/g, '_') // ký tự cấm cross-platform + control chars
    .trim()
    .replace(/[. ]+$/, ''); // dấu chấm/khoảng trắng cuối tên — quirk riêng của Windows

  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    cleaned = cleaned === '' ? 'untitled' : `_${cleaned}_`; // "." -> "_._", ".." -> "_.._"
  }

  const [base, ...rest] = cleaned.split('.');
  if (WINDOWS_RESERVED_NAMES.test(base)) {
    cleaned = [`${base}_`, ...rest].join('.');
  }

  return cleaned || 'untitled';
}

/** Header chuẩn của Google cho các link có gắn resourceKey bảo mật */
function resourceKeyHeaders(id: string, resourceKey?: string): HeadersInit | undefined {
  if (!resourceKey) return undefined;
  return { 'X-Goog-Drive-Resource-Keys': `${id}/${resourceKey}` };
}

async function driveFetch<T>(
  path: string,
  apiKey: string,
  params: Record<string, string> = {},
  headers?: HeadersInit
): Promise<T> {
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
  return res.json() as Promise<T>;
}

export async function getFileMeta(
  fileId: string,
  apiKey: string,
  resourceKey?: string
): Promise<DriveApiFileMeta> {
  return driveFetch<DriveApiFileMeta>(
    `/files/${fileId}`,
    apiKey,
    { fields: 'id,name,mimeType,size' },
    resourceKeyHeaders(fileId, resourceKey)
  );
}

/** Duyệt đệ quy toàn bộ folder, trả về danh sách phẳng các file (đã bỏ qua sub-folder).
 *
 * `resourceKey` tham số vào là của CHÍNH `folderId` đang được liệt kê (cần để tự
 * request tới folder này thành công) — KHÔNG dùng lại giá trị này cho file/folder
 * con. Mỗi item trả về từ API có thể mang `resourceKey` CỦA RIÊNG NÓ (field
 * output-only của Drive API v3); giá trị đó được đọc và gắn đúng vào từng file,
 * và truyền đúng xuống khi đệ quy vào từng subfolder — vì mỗi resource có thể
 * độc lập yêu cầu resourceKey khác nhau, không kế thừa từ folder cha.
 */
export async function listFolderRecursive(
  folderId: string,
  apiKey: string,
  basePath = '',
  resourceKey?: string
): Promise<DriveFile[]> {
  const results: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const data = await driveFetch<DriveApiListResponse>(
      '/files',
      apiKey,
      {
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size, resourceKey)',
        pageSize: '1000',
        includeItemsFromAllDrives: 'true',
        ...(pageToken ? { pageToken } : {}),
      },
      resourceKeyHeaders(folderId, resourceKey)
    );

    for (const file of data.files ?? []) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        // Đệ quy với resourceKey CỦA CHÍNH SUBFOLDER NÀY (nếu có) — không phải
        // resourceKey của folder cha đang duyệt.
        const sub = await listFolderRecursive(
          file.id,
          apiKey,
          `${basePath}${sanitize(file.name)}/`,
          file.resourceKey
        );
        results.push(...sub);
      } else {
        results.push({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          path: `${basePath}${sanitize(file.name)}`,
          resourceKey: file.resourceKey,
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

/** Chờ `ms`, nhưng huỷ ngay lập tức (không đợi hết `ms`) nếu `signal` abort giữa
 * chừng — tránh giữ timer vô ích sau khi client đã huỷ yêu cầu. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Đã huỷ theo yêu cầu.', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Đã huỷ theo yêu cầu.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
 *
 * Nếu `signal` được truyền và đã/bị abort giữa chừng (client đóng kết nối),
 * dừng ngay lập tức — không retry, không chờ backoff — để không tiếp tục kéo
 * dữ liệu từ Google một cách lãng phí sau khi không còn ai cần kết quả đó.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit | undefined,
  maxAttempts = 3,
  signal?: AbortSignal
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Đã huỷ theo yêu cầu.', 'AbortError');
    }
    try {
      const res = await fetch(url, signal ? { ...init, signal } : init);
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        await sleep(backoffMs(attempt), signal);
        continue;
      }
      return res;
    } catch (e) {
      // Huỷ chủ động không phải lỗi mạng chập chờn — ném ngay, không retry.
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      lastErr = e;
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt), signal);
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
 * Lý do an toàn để không giới hạn: kiến trúc streaming xử lý TỪNG FILE MỘT,
 * không giữ cả file trong RAM, nên bản thân dung lượng file/folder lớn tới đâu
 * không gây tràn RAM — giới hạn ở đây chỉ là lớp phòng hờ tuỳ chọn, không phải
 * điều kiện bắt buộc để tránh crash server.
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
