import { createLimiter } from './limiter.ts';

/**
 * Trần số lượt QUÉT thư mục chạy đồng thời trên toàn server (dùng chung cho /api/list và
 * giai đoạn quét đầu /api/download). Quét diễn ra TRƯỚC khi vào hàng đợi tải nên không
 * nằm dưới hạn mức MAX_CONCURRENT_DOWNLOADS — nếu không có trần riêng, nhiều request cùng
 * lúc sẽ cùng duyệt đệ quy những thư mục khổng lồ: ngốn RAM (mỗi lượt giữ cả danh sách
 * file) và đốt quota Google API của chủ server. Đầy thì từ chối ngay, người dùng thử lại.
 */
export const listingLimiter = createLimiter(4);

export const LISTING_BUSY_MESSAGE = 'Server đang quét quá nhiều thư mục cùng lúc. Vui lòng thử lại sau ít giây.';
