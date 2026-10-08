/**
 * Trích message từ một lỗi bất kỳ (unknown) một cách an toàn.
 *
 * JavaScript cho phép `throw` bất kỳ giá trị nào (không chỉ Error), nên biến
 * trong `catch` về mặt type phải là `unknown`, không phải `any` — dùng hàm này
 * để đọc `.message` an toàn thay vì đánh dấu biến lỗi là `any` (tắt type-check
 * trên biến đó, dù phần lớn các chỗ dùng chỉ cần đúng một giá trị: message
 * dạng chuỗi nếu có, fallback nếu không).
 */
export function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  return fallback;
}
