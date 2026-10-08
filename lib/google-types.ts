// Phần THUẦN (không phụ thuộc Node/server) về các định dạng "native" của Google —
// tách riêng để code chạy ở trình duyệt (client-drive.ts) dùng chung bảng export với
// server mà không phải kéo cả lib/drive.ts vào bundle client.

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

/** mimeType thuộc nhóm "native" của Google (kể cả loại KHÔNG export được như Forms/Sites). */
export function isGoogleNative(mimeType: string): boolean {
  return mimeType.startsWith('application/vnd.google-apps');
}

// Đuôi file "con trỏ" mà Google Drive for desktop để lại cho tài liệu native — chỉ những
// đuôi này mới được coi là "đuôi cũ cần thay" khi export.
const GOOGLE_POINTER_EXTS = new Set(['.gdoc', '.gsheet', '.gslides', '.gdraw']);

/**
 * Gắn đúng phần mở rộng cho file Google-native sau khi export (Doc → .docx, ...).
 *
 * CHỈ thay đuôi khi đó là đuôi con trỏ của Google (.gdoc/.gsheet/...) hoặc đã đúng đuôi
 * đích. Mọi dấu chấm khác là MỘT PHẦN CỦA TÊN ("Báo cáo v1.2", "Họp 12.03.2024") — phải
 * giữ nguyên và nối thêm đuôi, nếu không "Notes 1.5" và "Notes 1.6" cùng thành
 * "Notes 1.docx" (mất chữ + trùng tên).
 */
export function finalExtName(path: string, mimeType: string): string {
  const exportInfo = GOOGLE_EXPORT_MAP[mimeType];
  if (!exportInfo) return path;
  const m = path.match(/\.[^./]+$/);
  if (m) {
    const current = m[0].toLowerCase();
    if (current === exportInfo.ext) return path; // đã đúng đuôi đích
    if (GOOGLE_POINTER_EXTS.has(current)) return path.slice(0, -m[0].length) + exportInfo.ext;
  }
  return path + exportInfo.ext;
}
