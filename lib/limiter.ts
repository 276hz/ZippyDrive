/**
 * Hai tiện ích nhỏ dùng chung để chặn việc dùng tài nguyên không giới hạn trên server
 * nhỏ (Render free: 512MB RAM) — không phụ thuộc gì khác nên test được độc lập.
 */

/** Đọc số nguyên dương từ biến môi trường. Thiếu / rỗng / chữ / 0 / âm / Infinity → `fallback`
 * (KHÔNG để NaN lan ra: `Math.max(1, NaN)` là NaN chứ không phải 1 — xem ghi chú ở
 * download-lock.ts). */
export function positiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * Bộ đếm đồng thời KHÔNG xếp hàng: còn chỗ thì cho vào, hết chỗ thì từ chối NGAY (caller
 * trả 429/503 kèm lời nhắn thử lại). Dùng cho những việc nhẹ hơn tải zip (liệt kê thư
 * mục, proxy 1 file, SSE) — đủ để một người không thể mở hàng nghìn tác vụ cùng lúc.
 *
 * `tryEnter()` trả về hàm `leave` (gọi nhiều lần vẫn chỉ tính 1 lần) hoặc `null` nếu đầy.
 */
export function createLimiter(max: number) {
  let active = 0;
  return {
    tryEnter(): (() => void) | null {
      if (active >= max) return null;
      active += 1;
      let left = false;
      return () => {
        if (left) return;
        left = true;
        active -= 1;
      };
    },
    active: () => active,
    max,
  };
}
