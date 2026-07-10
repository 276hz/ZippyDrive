import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Nền carbon ấm — graphite/đen trung tính, KHÔNG ngả tím như theme SaaS mặc định.
        carbon: {
          950: '#0A0B09',
          900: '#111210',
          800: '#1A1B17',
          700: '#26271F',
        },
        // Vàng kraft — màu nhãn hồ sơ/thẻ bìa còng, dùng cho điểm nhấn phụ, nhãn, viền.
        kraft: {
          200: '#EBD9A8',
          300: '#DEC182',
          400: '#CFA55A',
          500: '#C99A4C',
          600: '#A87B36',
        },
        // Đỏ mực đóng dấu — MÀU HÀNH ĐỘNG DUY NHẤT (nút chính), dùng tiết chế.
        stamp: {
          400: '#D66A52',
          500: '#C1442E',
          600: '#A33420',
          700: '#822818',
        },
        // Xanh rêu — trạng thái hoàn tất/thành công, như dấu "ĐÃ DUYỆT".
        seal: {
          300: '#9CC2A0',
          400: '#7FAE83',
          500: '#6E9B6B',
          600: '#547A52',
        },
        // Xám xanh lạnh — chữ phụ, icon phụ, tạo tương phản mát với nền ấm.
        // ink-500: #71828A (đã chỉnh sáng hơn bản gốc #5E6D74 — bản cũ chỉ đạt ~3.7:1
        // trên nền carbon-950, dưới chuẩn WCAG AA 4.5:1 cho chữ nhỏ; giờ đạt ~4.95:1).
        ink: {
          200: '#C7CFD1',
          300: '#A6B1B5',
          400: '#7C8B94',
          500: '#71828A',
          600: '#454F55',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'ui-sans-serif', 'system-ui'],
        sans: ['var(--font-display)', 'ui-sans-serif', 'system-ui'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
