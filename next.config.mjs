/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  async headers() {
    const isDev = process.env.NODE_ENV !== 'production';
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // 'unsafe-eval' CHỈ cần cho `next dev` (React Fast Refresh dùng eval-based
              // module execution). Production build không cần — next/font đã tự tải
              // font về build-time nên style-src/font-src cũng KHÔNG cần domain Google
              // (khác với cách làm cũ dùng <link> trỏ thẳng fonts.googleapis.com).
              `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
              "style-src 'self' 'unsafe-inline'",
              "font-src 'self'",
              "connect-src 'self' https://www.googleapis.com",
              "img-src 'self' data:",
              // Architecture B (lib/client-zip.ts, useWebWorkers: true) tạo Web Worker
              // của @zip.js/zip.js qua blob:/data: URI (xác nhận trực tiếp trong
              // node_modules/@zip.js/zip.js — thư viện KHÔNG dùng file worker tĩnh cùng
              // origin). worker-src mặc định kế thừa từ script-src (không có blob:/data:)
              // nếu không khai báo riêng — thiếu dòng này sẽ khiến trình duyệt chặn việc
              // tạo worker. Thư viện có cơ chế fallback nội bộ nên KHÔNG crash ứng dụng,
              // nhưng hậu quả còn tệ hơn: mọi file bị âm thầm đánh dấu lỗi trong khi
              // download vẫn báo "thành công" — khó phát hiện hơn nhiều so với 1 lỗi rõ
              // ràng. Khai báo rõ đúng scope cần (worker-src), không mở rộng script-src.
              "worker-src 'self' blob: data:",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
