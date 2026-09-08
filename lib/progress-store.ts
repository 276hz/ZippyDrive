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
  status: 'queued' | 'running' | 'done' | 'error';
  queuePosition?: number; // 1 = kế tiếp sẽ được xử lý
  queueLength?: number;
  errorMessage?: string;
  startedAt: number;
}

const store = new Map<string, DownloadProgress>();

// Token cũ quá 30 phút coi như phiên tải đã kết thúc từ lâu (client đóng tab, mất
// mạng...) — dọn định kỳ để Map không phình to mãi theo thời gian server chạy.
const MAX_AGE_MS = 30 * 60 * 1000;

function cleanup() {
  const now = Date.now();
  for (const [key, val] of store) {
    if (now - val.startedAt > MAX_AGE_MS) store.delete(key);
  }
}

export function createProgress(token: string, totalFiles: number, initialStatus: DownloadProgress['status'] = 'queued') {
  cleanup();
  store.set(token, {
    totalFiles,
    completedFiles: 0,
    currentFileName: null,
    skipped: [],
    status: initialStatus,
    startedAt: Date.now(),
  });
}

export function updateProgress(token: string, patch: Partial<DownloadProgress>) {
  const p = store.get(token);
  if (!p) return;
  Object.assign(p, patch);
}

export function addSkipped(token: string, name: string, reason: string) {
  const p = store.get(token);
  if (!p) return;
  p.skipped.push({ name, reason });
}

export function getProgress(token: string): DownloadProgress | undefined {
  return store.get(token);
}

export function finishProgress(token: string, status: 'done' | 'error', errorMessage?: string) {
  const p = store.get(token);
  if (!p) return;
  p.status = status;
  p.errorMessage = errorMessage;
}
