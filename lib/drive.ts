import { GOOGLE_EXPORT_MAP, isGoogleNative } from './google-types.ts';
import { positiveIntEnv } from './limiter.ts';

// Re-export để các module/test hiện có vẫn import từ './drive'.
export { GOOGLE_EXPORT_MAP, finalExtName } from './google-types.ts';

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
export interface DriveApiFileMeta {
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

/** Message dùng chung khi ID không đúng định dạng Drive (chặn path traversal / chèn vào query `q`). */
const INVALID_ID_MESSAGE = 'ID Google Drive không hợp lệ.';

/** ID Drive chỉ gồm chữ/số/`_`/`-`. PHẢI kiểm tra trước khi nội suy ID vào URL path hoặc
 * chuỗi truy vấn `q` — nếu không, một ID như `../../x?y=1` sẽ đi tới endpoint khác của
 * www.googleapis.com cùng API key của server. */
export function isDriveId(id: string): boolean {
  return new RegExp(`^${ID_PATTERN}$`).test(id);
}

/** Vượt trần số file cho phép (MAX_FILES_PER_DOWNLOAD) — route trả 413. */
export class DriveLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriveLimitError';
  }
}

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
  // `trimmed`: bỏ ký tự ẩn (zero-width — hay dính khi copy từ ứng dụng di động) và
  // khoảng trắng 2 đầu. `cleaned`: bỏ LUÔN khoảng trắng nội bộ (copy dán link đôi khi
  // dính xuống dòng giữa chuỗi) — CHỈ dùng để parse URL. ID trần thì KHÔNG được dung
  // thứ khoảng trắng nội bộ đó: nếu không, câu như "please download my photos" sẽ bị
  // gộp thành "pleasedownloadmyphotos" rồi nhận nhầm là ID folder.
  const trimmed = raw.trim().replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  const cleaned = trimmed.replace(/\s+/g, '');

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
  if (isDriveId(trimmed)) {
    return { type: 'folder', id: trimmed };
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

  // Bước strip dấu chấm cuối ở trên đã biến "." và ".." thành chuỗi rỗng, nên chỉ cần
  // xử lý rỗng (→ "untitled") — path-traversal bằng "." / ".." đã bị chặn tại đó.
  if (cleaned === '') cleaned = 'untitled';

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
  headers?: HeadersInit,
  signal?: AbortSignal
): Promise<T> {
  const url = new URL(`${DRIVE_API}${path}`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('supportsAllDrives', 'true');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  // Có retry (429/5xx/403-rate-limit) + dừng ngay khi `signal` abort: trước đây một lỗi
  // 5xx thoáng qua ở trang liệt kê thứ N làm hỏng cả lượt quét, và client đã đóng tab
  // rồi server vẫn tiếp tục gọi API tới hết cây thư mục.
  const res = await fetchWithRetry(url.toString(), headers ? { headers } : undefined, 3, signal);
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
  resourceKey?: string,
  signal?: AbortSignal
): Promise<DriveApiFileMeta> {
  if (!isDriveId(fileId)) throw new Error(INVALID_ID_MESSAGE);
  return driveFetch<DriveApiFileMeta>(
    `/files/${fileId}`,
    apiKey,
    { fields: 'id,name,mimeType,size' },
    resourceKeyHeaders(fileId, resourceKey),
    signal
  );
}

export type DriveTarget =
  | { type: 'file'; id: string; resourceKey?: string; meta: DriveApiFileMeta }
  /** `meta` chỉ có thể `null` với folder khi không đọc được metadata (vẫn liệt kê nội dung
   * được, chỉ thiếu tên để đặt tên file zip). */
  | { type: 'folder'; id: string; resourceKey?: string; meta: DriveApiFileMeta | null };

/**
 * Chốt link đã parse là FILE hay FOLDER dựa trên metadata thật của Drive. `parseDriveUrl`
 * chỉ suy ra từ dạng URL, nên một ID trần dán vào (không có đường dẫn) luôn được coi là
 * folder — nếu thực ra là FILE thì liệt kê sẽ cho ra "folder rỗng", sai và khó hiểu. Ở đây
 * ID đó được xử lý đúng như một file.
 */
export async function resolveDriveTarget(link: ParsedDriveLink, apiKey: string, signal?: AbortSignal): Promise<DriveTarget> {
  if (link.type === 'file') {
    return { type: 'file', id: link.id, resourceKey: link.resourceKey, meta: await getFileMeta(link.id, apiKey, link.resourceKey, signal) };
  }
  let meta: DriveApiFileMeta | null = null;
  try {
    meta = await getFileMeta(link.id, apiKey, link.resourceKey, signal);
  } catch (e) {
    if (signal?.aborted) throw e; // client đã huỷ → dừng; lỗi khác thì chỉ mất tên, vẫn liệt kê được
  }
  if (meta && meta.mimeType !== 'application/vnd.google-apps.folder') {
    return { type: 'file', id: link.id, resourceKey: link.resourceKey, meta };
  }
  return { type: 'folder', id: link.id, resourceKey: link.resourceKey, meta };
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
export interface ListOptions {
  /** Huỷ giữa chừng (client đóng kết nối) → dừng duyệt ngay, không gọi thêm API. */
  signal?: AbortSignal;
  /** Trần số file. Vượt quá → ném DriveLimitError, để folder khổng lồ không âm thầm
   * ngốn RAM/quota API của server. Bỏ trống = không giới hạn. */
  maxFiles?: number;
}

export async function listFolderRecursive(
  folderId: string,
  apiKey: string,
  basePath = '',
  resourceKey?: string,
  options: ListOptions = {}
): Promise<DriveFile[]> {
  // MỘT mảng kết quả dùng chung cho cả đệ quy: tránh `results.push(...sub)` (spread một
  // mảng cực lớn vào đối số hàm có thể ném RangeError "Maximum call stack size").
  const results: DriveFile[] = [];
  await walkFolder(folderId, apiKey, basePath, resourceKey, options, results);
  return results;
}

async function walkFolder(
  folderId: string,
  apiKey: string,
  basePath: string,
  resourceKey: string | undefined,
  options: ListOptions,
  results: DriveFile[]
): Promise<void> {
  // ID được nội suy vào chuỗi truy vấn `q` (trong dấu nháy đơn) nên PHẢI đúng định dạng.
  if (!isDriveId(folderId)) throw new Error(INVALID_ID_MESSAGE);
  let pageToken: string | undefined;

  do {
    if (options.signal?.aborted) throw new DOMException('Đã huỷ theo yêu cầu.', 'AbortError');
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
      resourceKeyHeaders(folderId, resourceKey),
      options.signal
    );

    for (const file of data.files ?? []) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        // Đệ quy với resourceKey CỦA CHÍNH SUBFOLDER NÀY (nếu có) — không phải
        // resourceKey của folder cha đang duyệt.
        await walkFolder(file.id, apiKey, `${basePath}${sanitize(file.name)}/`, file.resourceKey, options, results);
      } else {
        results.push({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          path: `${basePath}${sanitize(file.name)}`,
          resourceKey: file.resourceKey,
        });
        if (options.maxFiles !== undefined && results.length > options.maxFiles) {
          throw new DriveLimitError(
            `Thư mục có hơn ${options.maxFiles.toLocaleString('vi-VN')} file — vượt giới hạn của server này. Hãy tải từng thư mục con, hoặc nâng MAX_FILES_PER_DOWNLOAD nếu bạn là chủ server.`
          );
        }
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
}

/** Xây URL + header để tải nội dung thật của 1 file */
export function buildDownloadRequest(
  fileId: string,
  mimeType: string,
  apiKey: string,
  resourceKey?: string
): { url: URL; headers?: HeadersInit } | null {
  // Chặn path traversal: ID đi thẳng vào URL path của www.googleapis.com (kèm API key).
  if (!isDriveId(fileId)) throw new Error(INVALID_ID_MESSAGE);
  const exportInfo = GOOGLE_EXPORT_MAP[mimeType];
  if (exportInfo) {
    const url = new URL(`${DRIVE_API}/files/${fileId}/export`);
    url.searchParams.set('mimeType', exportInfo.mimeType);
    url.searchParams.set('key', apiKey);
    return { url, headers: resourceKeyHeaders(fileId, resourceKey) };
  }
  if (isGoogleNative(mimeType)) {
    // Loại native không export được (Forms, Sites, Maps, Jamboard...)
    return null;
  }
  const url = new URL(`${DRIVE_API}/files/${fileId}`);
  url.searchParams.set('alt', 'media');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('key', apiKey);
  return { url, headers: resourceKeyHeaders(fileId, resourceKey) };
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

/** Lỗi tạm thời đáng thử lại: 429, 5xx, hoặc 403 do rate limit (đọc body bản sao để
 * phân biệt với 403 do không có quyền / hết quota ngày — những loại này thử lại vô ích). */
async function isRetryableResponse(res: Response): Promise<boolean> {
  if (res.status === 429 || res.status >= 500) return true;
  if (res.status !== 403) return false;
  try {
    return /ratelimitexceeded/i.test(await res.clone().text());
  } catch {
    return false;
  }
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* body đã bị khoá/đóng — bỏ qua */
  }
}

/**
 * fetch() có tự động thử lại tối đa `maxAttempts` lần khi gặp lỗi TẠM THỜI:
 * - Lỗi mạng (mất kết nối, DNS, timeout...) ném exception → bắt và thử lại.
 * - HTTP 429 (rate limit) hoặc 5xx (lỗi phía Google) → thử lại.
 * - HTTP 403 mang lý do rateLimitExceeded/userRateLimitExceeded → thử lại: Drive API
 *   báo rate limit bằng 403 (song song với 429) và Google khuyến nghị backoff với cả hai.
 * Lỗi 4xx khác (403 permission/quota ngày, 404 not found...) KHÔNG retry vì thử lại
 * cũng không đổi kết quả, chỉ tốn thời gian.
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
      if (attempt < maxAttempts && (await isRetryableResponse(res))) {
        await discardBody(res); // không để body chưa đọc giữ socket cho tới khi GC
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

/**
 * Đảm bảo MỌI path trong danh sách là duy nhất — Google Drive cho phép nhiều file cùng
 * tên trong một folder, và `sanitize`/`finalExtName` còn tạo thêm va chạm ("a/b" vs "a_b",
 * Doc "Report" vs file "Report.docx"). Zip có hai entry trùng tên thì khi giải nén sẽ bị
 * ghi đè hoặc hỏi — mất dữ liệu âm thầm.
 *
 * So sánh KHÔNG phân biệt hoa/thường và chuẩn hoá Unicode NFC (Windows/macOS coi
 * "IMG.JPG" và "img.jpg" là một file). Bản đầu tiên giữ nguyên tên; các bản trùng sau đó
 * thành "tên (2).đuôi", "tên (3).đuôi"... Một file cũng không được trùng tên với một
 * THƯ MỤC có trong danh sách. Thứ tự và các phần tử khác được giữ nguyên.
 */
export function uniquePaths<T extends { path: string }>(files: T[]): T[] {
  const key = (p: string) => p.normalize('NFC').toLowerCase();

  // Mọi thư mục cha xuất hiện trong danh sách ("a/b/c.txt" → "a", "a/b").
  const dirs = new Set<string>();
  // Tên gốc của TẤT CẢ file: bản "(2)" sinh ra không được đè lên tên gốc của file khác.
  const reserved = new Set<string>();
  for (const f of files) {
    reserved.add(key(f.path));
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(key(parts.slice(0, i).join('/')));
  }

  const used = new Set<string>();
  return files.map((f) => {
    let path = f.path;
    if (used.has(key(path)) || dirs.has(key(path))) {
      const slash = path.lastIndexOf('/');
      const dir = path.slice(0, slash + 1);
      const leaf = path.slice(slash + 1);
      const dot = leaf.lastIndexOf('.');
      const stem = dot > 0 ? leaf.slice(0, dot) : leaf; // ".gitignore" không bị coi là có đuôi
      const ext = dot > 0 ? leaf.slice(dot) : '';
      for (let n = 2; ; n++) {
        const candidate = `${dir}${stem} (${n})${ext}`;
        const k = key(candidate);
        if (!used.has(k) && !reserved.has(k) && !dirs.has(k)) {
          path = candidate;
          break;
        }
      }
    }
    used.add(key(path));
    return path === f.path ? f : { ...f, path };
  });
}

/** Trần số file cho MỘT lượt tải/quét (`MAX_FILES_PER_DOWNLOAD`, mặc định 20.000): chặn việc
 * một folder khổng lồ (hoặc một kẻ cố tình) bắt server giữ hàng trăm nghìn mục trong RAM và
 * đốt quota API. Chủ server có thể nâng nếu cần. */
export function maxFilesPerDownload(): number {
  return positiveIntEnv(process.env.MAX_FILES_PER_DOWNLOAD, 20000);
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
