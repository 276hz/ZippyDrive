import { updateProgress } from './progress-store';

/**
 * HÀNG ĐỢI xử lý tải zip — thay vì cho phép vô hạn lượt tải nặng chạy song song
 * (chắc chắn sập 512MB RAM / 0.1 CPU của Render free), server chỉ thực sự XỬ LÝ
 * (mở kết nối Google Drive + nén zip) cho tối đa `MAX_CONCURRENT` lượt cùng lúc.
 * Người tới sau được xếp hàng và tự động được xử lý ngay khi có slot trống —
 * không bị từ chối, không cần bấm tải lại. Với người dùng, cảm giác vẫn là "bấm
 * cái là tải được", chỉ hơi chờ vài giây/phút nếu server đang đông.
 *
 * MAX_CONCURRENT=3 là con số THỰC NGHIỆM cân bằng, không phải tuỳ tiện: mỗi lượt
 * tải zip đang mở tối đa 3 kết nối Drive song song (xem CONCURRENCY trong route
 * download) + 1 archiver instance, ước tính vài chục MB RAM/lượt. Với 512MB tổng
 * (trừ ~80-100MB Node.js + Next.js chạy nền), 3 lượt tải "nặng" cùng lúc là mức
 * an toàn hợp lý; con số này CÓ THỂ chỉnh qua env `MAX_CONCURRENT_DOWNLOADS` nếu
 * sau này đổi sang server RAM lớn hơn.
 */

interface QueueItem {
  token: string | null;
  resolve: () => void;
}

const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT_DOWNLOADS ?? 3));

let active = 0;
const queue: QueueItem[] = [];

function broadcastQueuePositions() {
  queue.forEach((item, idx) => {
    if (item.token) {
      updateProgress(item.token, {
        status: 'queued',
        queuePosition: idx + 1,
        queueLength: queue.length,
      });
    }
  });
}

/**
 * Chờ tới lượt được xử lý. Trả về 'acquired' khi có slot, hoặc 'aborted' nếu
 * `signal` bị huỷ TRONG LÚC còn đang xếp hàng (ví dụ người dùng đóng tab).
 */
export function acquireSlot(token: string | null, signal?: AbortSignal): Promise<'acquired' | 'aborted'> {
  return new Promise((resolve) => {
    if (active < MAX_CONCURRENT) {
      active += 1;
      resolve('acquired');
      return;
    }

    const item: QueueItem = { token, resolve: () => resolve('acquired') };
    queue.push(item);
    broadcastQueuePositions();

    const onAbort = () => {
      const idx = queue.indexOf(item);
      if (idx !== -1) {
        // Vẫn đang chờ trong hàng đợi (chưa được cấp slot) -> rút khỏi hàng đợi,
        // không tăng `active` vì chưa thực sự chiếm tài nguyên nào.
        queue.splice(idx, 1);
        broadcastQueuePositions();
        resolve('aborted');
      }
      // idx === -1 nghĩa là item đã được resolve('acquired') trước khi abort tới
      // -> đã đang chạy thật sự, việc release() sẽ do luồng xử lý chính lo (xem
      // route download: passthrough.on('close'/'error', releaseOnce)).
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Giải phóng 1 slot đang active, tự động cấp cho người đầu hàng đợi (nếu có). */
export function release() {
  active = Math.max(0, active - 1);
  const next = queue.shift();
  if (next) {
    active += 1;
    next.resolve();
  }
  broadcastQueuePositions();
}

export function currentActive() {
  return active;
}

export function currentQueueLength() {
  return queue.length;
}

export function maxConcurrent() {
  return MAX_CONCURRENT;
}
