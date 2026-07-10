import type { Metadata, Viewport } from 'next';
import { Be_Vietnam_Pro, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// Be Vietnam Pro: grotesk kỹ thuật, thiết kế riêng cho dấu tiếng Việt — dùng cho
// cả tiêu đề (đậm) lẫn nội dung (thường), thay vì font hệ thống mặc định.
const beVietnam = Be_Vietnam_Pro({
  subsets: ['latin', 'vietnamese'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-display',
  display: 'swap',
});

// JetBrains Mono: cho tên file, dung lượng, số đếm — cảm giác "danh sách đóng gói".
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ZippyDrive — Hốt trọn Google Drive, nén gọn 1 file .zip',
  description:
    'Dán link Google Drive công khai (folder hoặc file), ngó qua 1 phát rồi tải nguyên cục về máy dưới dạng 1 file .zip. Free 100%, không giới hạn dung lượng, chạy mượt trên mọi trình duyệt.',
  applicationName: 'ZippyDrive',
};

export const viewport: Viewport = {
  themeColor: '#0A0B09',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" className={`${beVietnam.variable} ${jetbrainsMono.variable}`}>
      <body className="antialiased text-ink-200 font-sans">{children}</body>
    </html>
  );
}
