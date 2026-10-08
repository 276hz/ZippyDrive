/**
 * Theo dõi tiến độ tải zip theo thời gian thực, lưu tạm trong bộ nhớ tiến trình
 * (module-level Map). Vì Render free chạy 1 instance server sống liên tục (không
 * phải serverless đa instance), Map này tồn tại xuyên suốt vòng đời server và đủ
 * dùng để chia sẻ trạng thái giữa route `/api/download` (ghi) và `/api/progress`
 * (đọc qua SSE) — không cần Redis hay DB ngoài cho quy mô 1 người/1 nhóm nhỏ dùng.
 */

export interface SkippedFile {
  name: string;
  reason: string;
}

export interface DownloadProgress {
  totalFiles: number;
  completedFiles: number;
  currentFileName: string | null;
  skipped: SkippedFile[];
  status: 'listing' | 'queued' | 'running' | 'done' | 'error'; // listing = đang quét cây thư mục trên Drive
  queuePosition?: number; // 1 = kế tiếp sẽ được xử lý
  queueLength?: number;
  errorMessage?: string;
  startedAt: number;
  /** Lần cuối entry này có động tĩnh (tạo/cập nhật/hoàn tất). Dùng để dọn rác thay cho
   * `startedAt` — xem ghi chú ở `cleanup()`. */
  updatedAt: number;
}

const store = new Map<string, DownloadProgress>();

/** Token do client tự sinh (UUID hoặc `<thời gian>-<ngẫu nhiên>`). Làm khoá của Map nên phải
 * giới hạn ký tự + độ dài — không để người ngoài nhét chuỗi tuỳ ý/khổng lồ vào bộ nhớ. */
export function isValidToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{8,100}$/.test(token);
}

// Trần cứng số phiên lưu cùng lúc (phòng spam token ngẫu nhiên). Vượt trần thì bỏ phiên ĐÃ
// XONG cũ nhất trước, rồi mới tới phiên cũ nhất bất kỳ — không bao giờ để Map phình vô hạn.
const MAX_ENTRIES = 2000;


// Dọn định kỳ để Map không phình to mãi theo thời gian server chạy.
//
// KHÔNG được tính tuổi từ lúc BẮT ĐẦU: trước đây entry bị xoá sau 30 phút kể từ `startedAt`
// (gồm cả thời gian xếp hàng), và `cleanup()` chạy mỗi khi có NGƯỜI KHÁC bắt đầu tải — nên một
// lượt tải folder hàng chục GB (chạy > 30 phút) bị xoá tiến độ giữa chừng, các lần
// `updateProgress` sau đó âm thầm thành no-op và tab đang mở mất theo dõi. Giờ:
//   - phiên ĐÃ XONG/LỖI: giữ 30 phút kể từ lần cập nhật cuối (đủ để tab còn mở đọc kết quả);
//   - phiên còn đang chạy/xếp hàng: chỉ coi là rò rỉ nếu im lặng hơn 6 giờ.
const FINISHED_TTL_MS = 30 * 60 * 1000;
const STALE_TTL_MS = 6 * 60 * 60 * 1000;

function cleanup() {
  const now = Date.now();
  for (const [key, val] of store) {
    const finished = val.status === 'done' || val.status === 'error';
    if (now - val.updatedAt > (finished ? FINISHED_TTL_MS : STALE_TTL_MS)) store.delete(key);
  }
}

function enforceEntryCap() {
  if (store.size < MAX_ENTRIES) return;
  for (const [key, val] of store) {
    if (store.size < MAX_ENTRIES) return;
    if (val.status === 'done' || val.status === 'error') store.delete(key);
  }
  for (const key of store.keys()) {
    if (store.size < MAX_ENTRIES) return;
    store.delete(key); // Map giữ thứ tự chèn → xoá phiên cũ nhất
  }
}

export function createProgress(token: string, totalFiles: number, initialStatus: DownloadProgress['status'] = 'queued') {
  cleanup();
  enforceEntryCap();
  const now = Date.now();
  store.set(token, {
    totalFiles,
    completedFiles: 0,
    currentFileName: null,
    skipped: [],
    status: initialStatus,
    startedAt: now,
    updatedAt: now,
  });
}

export function updateProgress(token: string, patch: Partial<DownloadProgress>) {
  const p = store.get(token);
  if (!p) return;
  Object.assign(p, patch);
  p.updatedAt = Date.now();
}

export function addSkipped(token: string, name: string, reason: string) {
  const p = store.get(token);
  if (!p) return;
  p.skipped.push({ name, reason });
  p.updatedAt = Date.now();
}

export function getProgress(token: string): DownloadProgress | undefined {
  return store.get(token);
}

export function finishProgress(token: string, status: 'done' | 'error', errorMessage?: string) {
  const p = store.get(token);
  if (!p) return;
  p.status = status;
  p.errorMessage = errorMessage;
  p.updatedAt = Date.now();
}

/** Báo "phiên này vẫn còn sống" (vd. đang truyền 1 file rất lớn, chưa có file nào xong) để
 * `cleanup()` không coi là rò rỉ. */
export function touchProgress(token: string) {
  const p = store.get(token);
  if (p) p.updatedAt = Date.now();
}
