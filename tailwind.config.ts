import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    borderRadius: {
      none: '0px',
      sm: '5px',
      DEFAULT: '6px',
      md: '8px',
      lg: '10px',
      xl: '12px',
      '2xl': '14px',
      '3xl': '18px',
      full: '9999px',
    },
    extend: {
      colors: {
        void: {
          950: '#050506',
          900: '#0A0A0C',
          850: '#0D0E10',
          800: '#131417',
          700: '#1C1E22',
          600: '#26282D',
        },
        // Cyan — accent nhận diện chính, dùng cho MỌI phần tử tương tác (nút,
        // link, focus, trạng thái). Tên "accent" tránh trùng key "cyan" mặc định.
        accent: {
          200: '#C6FBFF',
          300: '#8FF3FF',
          400: '#3FE0F5',
          500: '#00CFE8',
          600: '#00A6BD',
          700: '#00747F',
        },
        // Azure — sắc lam sâu hơn, CHỈ dùng làm điểm dừng thứ hai trong gradient
        // (chữ, atmosphere, viền) để tạo chiều sâu "cyan → blue". Không dùng làm
        // màu nút/link độc lập — giữ hệ thống 1 accent thao tác duy nhất.
        azure: {
          400: '#4FA3FF',
          500: '#1E7FE0',
          600: '#125FB0',
        },
        ink: {
          100: '#F2F2F2',
          200: '#D6D6D6',
          300: '#AFAFAF',
          400: '#868686',
          500: '#666666',
          600: '#454545',
          700: '#2C2C2C',
          800: '#1B1B1B',
        },
        signal: {
          400: '#FF6B5C',
          500: '#FF4433',
          600: '#D6301F',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'ui-sans-serif', 'system-ui'],
        sans: ['var(--font-display)', 'ui-sans-serif', 'system-ui'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      letterSpacing: {
        tightest: '-0.045em',
        widest2: '0.14em',
      },
      boxShadow: {
        // Glow dùng riêng cho tương tác quan trọng (hover CTA, focus input) —
        // không áp cho phần tử tĩnh, tránh trang phát sáng lan man.
        glow: '0 0 0 3px rgba(63,224,245,0.12), 0 0 32px -6px rgba(63,224,245,0.5)',
        'glow-sm': '0 0 20px -6px rgba(63,224,245,0.45)',
      },
    },
  },
  plugins: [],
};

export default config;
