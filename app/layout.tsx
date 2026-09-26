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
  title: 'ZippyDrive — Google Drive của bạn, gói gọn trong một file .zip',
  description:
    'Dán link Google Drive công khai (folder hoặc file) — hệ thống quét toàn bộ cấu trúc, nén streaming và trả về đúng một file .zip. Miễn phí 100%, không giới hạn dung lượng, không cần đăng nhập.',
  applicationName: 'ZippyDrive',
};

export const viewport: Viewport = {
  themeColor: '#050506',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" className={`${beVietnam.variable} ${jetbrainsMono.variable}`}>
      <body className="antialiased text-ink-200 font-sans">{children}</body>
    </html>
  );
}
