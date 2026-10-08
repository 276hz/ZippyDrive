/**
 * Phía trình duyệt: dạng tiến độ mà giao diện giữ trong state, và cách "làm sạch" thông điệp SSE
 * từ /api/progress trước khi đưa vào state.
 *
 * Tách ra file riêng (thuần, không phụ thuộc React) để test được. Lý do tồn tại: trước đây
 * `es.onmessage` nhét NGUYÊN VĂN mọi thông điệp vào state. Trong lúc server còn đang quét thư mục
 * (chưa có phiên tiến độ), /api/progress gửi `{"status":"unknown"}` — không có trường `skipped` —
 * và dòng `liveProgress.skipped.length` trong lúc render ném TypeError, đẩy cả trang sang màn hình
 * lỗi (app/error.tsx) dù lượt tải vẫn đang chạy.
 */

export interface LiveProgress {
  totalFiles: number;
  completedFiles: number;
  currentFileName: string | null;
  skipped: { name: string; reason: string }[];
  /** `listing` = server đang quét cây thư mục trên Drive (chưa biết tổng số file). */
  status: 'listing' | 'queued' | 'running' | 'done' | 'error';
  queuePosition?: number;
  queueLength?: number;
  errorMessage?: string;
}

const STATUSES: readonly string[] = ['listing', 'queued', 'running', 'done', 'error'];

function isSkipped(x: unknown): x is { name: string; reason: string } {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as Record<string, unknown>).name === 'string' &&
    typeof (x as Record<string, unknown>).reason === 'string'
  );
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Chuẩn hoá 1 thông điệp SSE thành `LiveProgress` ĐẦY ĐỦ trường (luôn có `skipped` là mảng...).
 *
 * Trả về `null` nếu thông điệp không dùng được — quan trọng nhất là `{"status":"unknown"}`
 * ("chưa có phiên tiến độ" — server chưa kịp tạo, hoặc token không tồn tại): người gọi PHẢI bỏ
 * qua thông điệp đó và giữ nguyên trạng thái đang hiển thị, thay vì ghi đè bằng thứ thiếu trường.
 */
export function normalizeProgressMessage(raw: unknown): LiveProgress | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.status !== 'string' || !STATUSES.includes(m.status)) return null;
  return {
    totalFiles: num(m.totalFiles),
    completedFiles: num(m.completedFiles),
    currentFileName: typeof m.currentFileName === 'string' ? m.currentFileName : null,
    skipped: Array.isArray(m.skipped) ? m.skipped.filter(isSkipped) : [],
    status: m.status as LiveProgress['status'],
    queuePosition: optNum(m.queuePosition),
    queueLength: optNum(m.queueLength),
    errorMessage: typeof m.errorMessage === 'string' ? m.errorMessage : undefined,
  };
}
