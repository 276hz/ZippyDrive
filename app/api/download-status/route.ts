import { NextResponse } from 'next/server';
import { currentActive, currentQueueLength, maxConcurrent } from '@/lib/download-lock';

export const runtime = 'nodejs';

/** Thông tin tham khảo cho client (ví dụ hiện chỉ báo trạng thái server, KHÔNG
 * còn dùng để chặn điều hướng — giờ server tự xếp hàng thay vì từ chối lượt
 * tải, nên client cứ điều hướng bình thường và xem tiến độ hàng đợi qua SSE). */
export async function GET() {
  const active = currentActive();
  const max = maxConcurrent();
  const queueLength = currentQueueLength();
  return NextResponse.json({ active, max, queueLength, busy: active >= max });
}
