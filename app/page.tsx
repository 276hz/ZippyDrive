'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Search,
  Download,
  Check,
  Loader2,
  ClipboardPaste,
  Pencil,
  X,
  ChevronDown,
  ChevronUp,
  Bell,
  ArrowRight,
  Link2,
} from 'lucide-react';
import { directDownloadEnabled, downloadFolderDirect } from '@/lib/client-drive';
import { fsaSupported, downloadFolderAsZip } from '@/lib/client-zip';

interface PreviewFile {
  id: string;
  path: string;
  mimeType: string;
  size: number | null;
}

interface PreviewResult {
  isFolder: boolean;
  name: string;
  files: PreviewFile[];
  totalCount: number;
  totalSize: number | null;
  unknownSizeCount?: number;
  resourceKey?: string | null;
  sizeLimit?: number | null;
  exceedsLimit?: boolean;
}

interface HistoryEntry {
  id: string;
  name: string;
  count: number;
  size: number | null;
  startedAt: Date;
  finishedAt: Date | null;
}

interface LiveProgress {
  totalFiles: number;
  completedFiles: number;
  currentFileName: string | null;
  skipped: { name: string; reason: string }[];
  status: 'queued' | 'running' | 'done' | 'error' | 'unknown';
  queuePosition?: number;
  queueLength?: number;
  errorMessage?: string;
}

type Stage = 'idle' | 'previewing' | 'error';

const SPECS = [
  {
    title: 'Không giới hạn dung lượng',
    desc: 'Nén streaming từng file một, không giữ toàn bộ trong RAM. Folder hàng chục GB vẫn chạy êm trên server miễn phí.',
    tag: 'Không tràn RAM',
  },
  {
    title: 'Giữ nguyên cấu trúc',
    desc: 'Toàn bộ thư mục con được giữ nguyên trật tự trong file zip đầu ra — không đảo lộn, không thất lạc.',
    tag: 'Giữ nguyên cây thư mục',
  },
  {
    title: 'Tự chuyển định dạng',
    desc: 'Google Docs / Sheets / Slides tự động xuất ra .docx / .xlsx / .pptx ngay khi đóng gói.',
    tag: 'Docs → Office',
  },
  {
    title: 'Chạy mọi trình duyệt',
    desc: 'Chrome, Safari, Firefox, Edge — desktop lẫn mobile, không cần cài thêm gì, không cần tài khoản.',
    tag: 'Không cần đăng nhập',
  },
];

const MANIFESTO = [
  { key: 'login_required', value: 'NEVER', comment: 'Không tài khoản, không cookie theo dõi.' },
  { key: 'max_file_size', value: 'UNLIMITED', comment: 'Nén streaming — không giới hạn theo mặc định.' },
  { key: 'folder_structure', value: 'PRESERVED', comment: 'Toàn bộ cây thư mục giữ nguyên trong file zip.' },
  { key: 'ads', value: 'NEVER', comment: 'Không quảng cáo, không popup, không upsell.' },
];

/* ---------- Hooks ---------- */

function useCountUp(target: number, duration = 700) {
  const [value, setValue] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    const reduceMotion =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) { setValue(target); fromRef.current = target; return; }
    const from = fromRef.current;
    const start = performance.now();
    let raf: number;
    function tick(now: number) {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(from + (target - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

/** Gắn class "is-visible" khi phần tử cuộn vào khung nhìn. */
/** Gắn "is-visible" khi phần tử cuộn vào khung nhìn — CHỈ là progressive
 * enhancement, KHÔNG BAO GIỜ là điều kiện để nội dung tồn tại/hiển thị.
 *
 * Kiến trúc: mặc định LUÔN visible=true — kể cả trong HTML server-render
 * trước khi bất kỳ JS nào chạy, kể cả khi trình duyệt không hỗ trợ
 * IntersectionObserver, kể cả khi công cụ chụp full-page screenshot không
 * mô phỏng cuộn trang thật. Chỉ khi effect xác nhận (qua getBoundingClientRect,
 * chạy 1 lần, không dùng scroll listener) một phần tử THỰC SỰ nằm dưới fold
 * lúc mount, mới tạm ẩn nó để chờ hiệu ứng reveal khi cuộn tới — và ngay cả
 * lúc đó vẫn có lưới an toàn (setTimeout 1s) tự hiện lại nếu vì lý do gì
 * IntersectionObserver không kịp kích hoạt, đảm bảo không bao giờ mắc kẹt ở
 * trạng thái ẩn vĩnh viễn. */
function useReveal<T extends HTMLElement>(threshold = 0.15) {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Tôn trọng reduced-motion tuyệt đối: không ẩn gì, không tạo hiệu ứng.
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) return;

    // Trình duyệt không hỗ trợ IntersectionObserver — giữ visible=true mặc
    // định thay vì có nguy cơ ẩn nội dung không ai reveal lại được.
    if (typeof IntersectionObserver === 'undefined') return;

    // Đã nằm trong khung nhìn ngay lúc trang vừa tải — không ẩn rồi hiện lại,
    // vì người dùng ĐANG thấy nó, ẩn đi sẽ gây "nháy" khó chịu.
    const rect = el.getBoundingClientRect();
    const alreadyInView = rect.top < window.innerHeight && rect.bottom > 0;
    if (alreadyInView) return;

    // Thực sự ở dưới fold — cho phép hiệu ứng reveal khi cuộn tới.
    setVisible(false);

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          io.disconnect();
          clearTimeout(safety);
        }
      },
      { threshold }
    );
    io.observe(el);

    // Lưới an toàn tuyệt đối: nếu IntersectionObserver vì bất kỳ lý do gì
    // không kích hoạt kịp (công cụ tự động không mô phỏng cuộn thật, tab chạy
    // nền, v.v...), nội dung vẫn PHẢI hiện ra trong tối đa 1 giây.
    const safety = setTimeout(() => {
      setVisible(true);
      io.disconnect();
    }, 1000);

    return () => {
      io.disconnect();
      clearTimeout(safety);
    };
  }, [threshold]);
  return [ref, visible] as const;
}

/* ---------- Formatters ---------- */

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const s = (totalSeconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function formatTimestamp(d: Date): string {
  return d.toLocaleTimeString('vi-VN', { hour12: false }) + ' · ' + d.toLocaleDateString('vi-VN');
}

function splitExt(path: string): { base: string; ext: string } {
  const m = path.match(/^(.*?)(\.[^./]+)?$/);
  return { base: m?.[1] ?? path, ext: m?.[2] ?? '' };
}

function pad2(n: number) {
  return n.toString().padStart(2, '0');
}

/* ---------- Small presentational pieces ---------- */

/** Nhãn mở đầu section: chấm nhỏ + nhãn hoa + đường kẻ vẽ vào + (tuỳ chọn)
 * metadata kỹ thuật. Không còn là pill/badge — chỉ còn chữ và đường kẻ, đúng
 * tinh thần editorial thay vì "SaaS eyebrow chip". */
function SectionKicker({
  children,
  meta,
  visible = true,
}: {
  children: React.ReactNode;
  meta?: string;
  visible?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <span
        className="w-1.5 h-1.5 rounded-full bg-accent-400 shrink-0 shadow-[0_0_8px_2px_rgba(63,224,245,0.5)]"
        aria-hidden="true"
      />
      <span className="text-[11px] font-bold tracking-widest2 text-ink-300 uppercase whitespace-nowrap">
        {children}
      </span>
      <span
        className={`h-px flex-1 bg-gradient-to-r from-white/15 to-transparent ${visible ? 'rule-draw' : 'scale-x-0'}`}
        style={{ transformOrigin: 'left' }}
        aria-hidden="true"
      />
      {meta && (
        <span className="hidden md:inline font-mono text-[10px] tracking-widest2 text-ink-600 uppercase shrink-0">
          {meta}
        </span>
      )}
    </div>
  );
}

/** Cụm số liệu kỹ thuật thống nhất — số lớn mono + nhãn nhỏ bên dưới. Một
 * "tầng DATA" nhất quán dùng lại ở mọi nơi có số liệu. */
function DataStat({
  value,
  label,
  tone = 'white',
  size = 'md',
}: {
  value: string;
  label: string;
  tone?: 'white' | 'accent';
  size?: 'md' | 'lg';
}) {
  return (
    <div>
      <span
        className={[
          'block font-mono font-bold tabular-nums leading-none',
          size === 'lg' ? 'text-2xl sm:text-3xl' : 'text-xl',
          tone === 'accent' ? 'text-accent-400' : 'text-white',
          size === 'lg' ? 'text-glow' : '',
        ].join(' ')}
      >
        {value}
      </span>
      <span className="block mt-1.5 font-mono text-[10px] font-bold tracking-widest2 text-ink-500 uppercase">
        {label}
      </span>
    </div>
  );
}

/** 3 nút điều khiển cửa sổ kiểu macOS thật — màu chuẩn (#FF5F57/#FEBC2E/#28C840),
 * có gợi sáng bóng nhẹ ở góc trên-trái mỗi nút để trông như nút vật lý, không
 * phải chấm màu phẳng. Đây là ngoại lệ DUY NHẤT có chủ đích của hệ màu
 * cyan/lam/xám toàn sản phẩm — không tái sử dụng 3 màu này ở bất kỳ đâu khác.
 * Dùng hex trực tiếp (không qua token Tailwind) vì hiệu ứng gloss cần
 * radial-gradient lồng trong background, không biểu diễn gọn bằng class được. */
function TrafficLights() {
  const dot = (hex: string) => ({
    background: `radial-gradient(circle at 34% 30%, rgba(255,255,255,0.55), transparent 55%), ${hex}`,
  });
  return (
    <div className="flex items-center gap-2" aria-hidden="true">
      <span className="w-3 h-3 rounded-full" style={dot('#FF5F57')} />
      <span className="w-3 h-3 rounded-full" style={dot('#FEBC2E')} />
      <span className="w-3 h-3 rounded-full" style={dot('#28C840')} />
    </div>
  );
}

/** Link điều hướng, gạch chân "vẽ vào" khi hover — không nền, không pill. */
function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="hidden sm:inline-block relative px-0.5 py-1.5 text-[13px] font-semibold text-ink-400 hover:text-white bg-gradient-to-r from-accent-400 to-azure-400 bg-no-repeat bg-left-bottom bg-[length:0%_1.5px] hover:bg-[length:100%_1.5px] transition-[background-size,color] duration-300 ease-out"
    >
      {children}
    </a>
  );
}

export default function Page() {
  const [url, setUrl] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [scannedAt, setScannedAt] = useState<Date | null>(null);
  const [outputBase, setOutputBase] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [showFileList, setShowFileList] = useState(false);

  const [activeDownload, setActiveDownload] = useState<{
    historyId: string;
    kind: 'zip' | 'file' | 'direct';
    abortController?: AbortController;
  } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [liveProgress, setLiveProgress] = useState<LiveProgress | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [pasteSupported, setPasteSupported] = useState(false);
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  const countFiles = useCountUp(preview?.totalCount ?? 0);
  const countBytes = useCountUp(preview?.totalSize ?? 0);

  const [fsaAvailable, setFsaAvailable] = useState(false);
  useEffect(() => {
    setPasteSupported(typeof navigator !== 'undefined' && !!navigator.clipboard?.readText);
    setFsaAvailable(fsaSupported());
    if (typeof Notification !== 'undefined') {
      setNotifPermission(Notification.permission);
    }
  }, []);

  useEffect(() => () => { eventSourceRef.current?.close(); }, []);

  useEffect(() => {
    if (activeDownload) {
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [!!activeDownload]);

  useEffect(() => {
    if (liveProgress?.status === 'done' && activeDownload?.kind === 'zip') {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      setHistory((h) =>
        h.map((entry) =>
          entry.id === activeDownload.historyId ? { ...entry, finishedAt: new Date() } : entry
        )
      );
      sendNotification(activeDownload.historyId);
    }
  }, [liveProgress?.status]);

  const sendNotification = useCallback((historyId: string) => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (document.hasFocus()) return;
    const entry = history.find((h) => h.id === historyId);
    new Notification('ZippyDrive — Đã đóng gói xong', {
      body: entry ? `${entry.name} đã sẵn sàng trong thư mục Downloads.` : 'File zip đã tải xong.',
      icon: '/favicon.ico',
    });
  }, [history]);

  async function requestNotifPermission() {
    if (typeof Notification === 'undefined') return;
    const perm = await Notification.requestPermission();
    setNotifPermission(perm);
  }

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setUrl(text.trim());
    } catch { /* clipboard blocked */ }
  }

  function resetToIdle() {
    if (activeDownload?.abortController) activeDownload.abortController.abort();
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setActiveDownload(null);
    setLiveProgress(null);
    setPreview(null);
    setScannedAt(null);
    setStage('idle');
    setError('');
    setOutputBase('');
    setShowFileList(false);
    setTimeout(() => urlInputRef.current?.focus(), 50);
  }

  async function handlePreview() {
    setError('');
    setPreview(null);
    setScannedAt(null);
    setShowFileList(false);

    if (!url.trim()) {
      setError('Hãy nhập link Google Drive hợp lệ.');
      urlInputRef.current?.focus();
      return;
    }
    setStage('previewing');
    try {
      const res = await fetch('/api/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Có lỗi xảy ra.');
      if (data.totalCount === 0)
        throw new Error('Folder trống hoặc không có file nào được chia sẻ công khai.');
      setPreview(data);
      setScannedAt(new Date());
      const { base } = splitExt(data.name || 'drive-download');
      setOutputBase(data.isFolder ? data.name || 'drive-download' : base);
      setStage('idle');
    } catch (e: any) {
      setError(e?.message ?? 'Có lỗi xảy ra.');
      setStage('error');
      urlInputRef.current?.focus();
    }
  }

  function genToken() {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function closeProgressStream() {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }

  async function handleDownload() {
    if (!preview) return;
    setError('');

    if (preview.exceedsLimit) {
      setError(`Folder vượt giới hạn ${formatBytes(preview.sizeLimit)} của server miễn phí. Hãy chia nhỏ folder rồi tải từng phần.`);
      return;
    }

    const isSingleFile = !preview.isFolder && preview.files.length === 1;
    const { ext } = isSingleFile ? splitExt(preview.files[0].path) : { ext: '.zip' };
    const finalName = `${outputBase.trim() || 'drive-download'}${ext}`;

    const token = genToken();
    const endpoint = isSingleFile
      ? `/api/proxy?${new URLSearchParams({
          id: preview.files[0].id,
          mime: preview.files[0].mimeType,
          name: finalName,
          ...(preview.resourceKey ? { key: preview.resourceKey } : {}),
        })}`
      : `/api/download?${new URLSearchParams({
          url,
          name: outputBase.trim() || 'drive-download',
          token,
        })}`;

    const historyId = `${Date.now()}`;
    setHistory((h) => [
      { id: historyId, name: finalName, count: preview.totalCount, size: preview.totalSize, startedAt: new Date(), finishedAt: null },
      ...h,
    ]);
    setElapsed(0);
    setLiveProgress(
      isSingleFile
        ? null
        : { totalFiles: preview.totalCount, completedFiles: 0, currentFileName: null, skipped: [], status: 'queued' }
    );
    setActiveDownload({ historyId, kind: isSingleFile ? 'file' : 'zip' });

    if (!isSingleFile) {
      closeProgressStream();
      const es = new EventSource(`/api/progress?token=${encodeURIComponent(token)}`);
      es.onmessage = (ev) => {
        try { setLiveProgress(JSON.parse(ev.data) as LiveProgress); } catch { /* ignore */ }
      };
      es.onerror = () => closeProgressStream();
      eventSourceRef.current = es;
    }

    if (isSingleFile) {
      window.location.href = endpoint;
      setTimeout(() => {
        setHistory((h) =>
          h.map((entry) => (entry.id === historyId ? { ...entry, finishedAt: new Date() } : entry))
        );
      }, 2000);
    } else {
      window.location.href = endpoint;
    }
  }

  async function handleDownloadDirect() {
    if (!preview) return;
    setError('');

    const historyId = `${Date.now()}`;
    const finalLabel = fsaAvailable
      ? `${outputBase.trim() || preview.name}.zip (trực tiếp)`
      : `${outputBase.trim() || preview.name} (${preview.totalCount} file rời)`;

    setHistory((h) => [
      { id: historyId, name: finalLabel, count: preview.totalCount, size: preview.totalSize, startedAt: new Date(), finishedAt: null },
      ...h,
    ]);
    setElapsed(0);
    setLiveProgress({ totalFiles: preview.totalCount, completedFiles: 0, currentFileName: null, skipped: [], status: 'running' });

    const abortController = new AbortController();
    setActiveDownload({ historyId, kind: 'direct', abortController });

    const onProgress = (p: LiveProgress) => setLiveProgress(p);

    let cancelled = false;
    let failure: string | null = null;

    if (fsaAvailable) {
      const result = await downloadFolderAsZip(
        preview.files,
        preview.resourceKey,
        outputBase.trim() || preview.name,
        onProgress,
        abortController.signal
      );
      if (!result.ok) {
        if (result.cancelled) cancelled = true;
        else failure = result.error;
      }
    } else {
      const result = await downloadFolderDirect(preview.files, preview.resourceKey, onProgress, abortController.signal);
      cancelled = result.cancelled;
    }

    // Người dùng đã chủ động huỷ: handleCancelDownload đã dọn UI (xoá lịch sử,
    // đóng panel) ngay lúc bấm rồi — không làm gì thêm ở đây, tránh đè lên
    // state mà người dùng có thể đã thay đổi sau khi huỷ (vd. đã dán link khác),
    // và tránh hiện thông báo/lỗi trễ cho một tác vụ đã bị huỷ từ trước.
    if (cancelled) return;

    if (failure) {
      setError(failure);
      setActiveDownload(null);
      setHistory((h) => h.filter((entry) => entry.id !== historyId));
      return;
    }

    setHistory((h) =>
      h.map((entry) => (entry.id === historyId ? { ...entry, finishedAt: new Date() } : entry))
    );
    sendNotification(historyId);
  }

  function handleCancelDownload() {
    if (!activeDownload) return;
    if (activeDownload.abortController) activeDownload.abortController.abort();
    closeProgressStream();
    setHistory((h) => h.filter((entry) => entry.id !== activeDownload.historyId));
    setActiveDownload(null);
    setLiveProgress(null);
  }

  function handleMarkDone() {
    if (!activeDownload) return;
    closeProgressStream();
    setHistory((h) =>
      h.map((entry) =>
        entry.id === activeDownload.historyId && !entry.finishedAt
          ? { ...entry, finishedAt: new Date() }
          : entry
      )
    );
    setActiveDownload(null);
    setLiveProgress(null);
  }

  const activeEntry = history.find((h) => h.id === activeDownload?.historyId);
  const directAvailable = directDownloadEnabled();
  const isDone = liveProgress?.status === 'done';

  /** Một dòng trạng thái duy nhất thay cho stepper 3 ô — trạng thái được suy
   * ra thuần từ state hiện có, không thêm state mới, không đổi hành vi. */
  function computeStatus(): { label: string; tone: 'idle' | 'active' | 'done' | 'error' } {
    if (activeDownload) {
      if (isDone) return { label: 'Hoàn tất', tone: 'done' };
      if (liveProgress?.status === 'queued') return { label: 'Đang xếp hàng', tone: 'active' };
      if (liveProgress?.status === 'error') return { label: 'Lỗi', tone: 'error' };
      return { label: activeDownload.kind === 'file' ? 'Đang tải' : 'Đang nén', tone: 'active' };
    }
    if (preview) return { label: 'Sẵn sàng', tone: 'done' };
    if (stage === 'previewing') return { label: 'Đang kiểm tra', tone: 'active' };
    if (stage === 'error') return { label: 'Chờ link mới', tone: 'error' };
    return { label: 'Chờ link', tone: 'idle' };
  }
  const status = computeStatus();
  const statusToneClass = {
    idle: 'text-ink-500',
    active: 'text-accent-400',
    done: 'text-accent-400',
    error: 'text-signal-500',
  }[status.tone];

  const progressPct = liveProgress && liveProgress.totalFiles > 0
    ? Math.min(100, Math.round((liveProgress.completedFiles / liveProgress.totalFiles) * 100))
    : 0;

  const [specRef, specVisible] = useReveal<HTMLDivElement>();
  const [manifestoRef, manifestoVisible] = useReveal<HTMLDivElement>();
  const [historyRef, historyVisible] = useReveal<HTMLDivElement>();
  const [footerRef, footerVisible] = useReveal<HTMLElement>();

  return (
    <main className="min-h-screen text-ink-200 font-sans overflow-x-hidden">
      {/* ================= NAV — slim technical bar ================= */}
      <header className="animate-reveal-sm sticky top-0 z-50 w-full border-b border-white/10 bg-void-950/75 backdrop-blur-md">
        <div className="mx-auto max-w-6xl px-5 sm:px-8 h-14 sm:h-16 flex items-center justify-between gap-4">
          <a href="#top" className="flex items-center gap-2 shrink-0">
            <span className="w-2 h-2 bg-accent-400 rounded-sm shadow-[0_0_10px_1px_rgba(63,224,245,0.45)]" aria-hidden="true" />
            <span className="font-display text-[14px] font-extrabold tracking-tight text-white">
              Zippy<span className="text-accent-400">Drive</span>
            </span>
          </a>
          <nav className="flex items-center gap-6">
            <NavLink href="#spec">Thông số</NavLink>
            <NavLink href="#manifesto">Cam kết</NavLink>
            {history.length > 0 && <NavLink href="#log">Nhật ký</NavLink>}
          </nav>
          <a
            href="#tool"
            className="group relative inline-flex items-center overflow-hidden shrink-0 border border-accent-400/50 px-4 py-1.5 text-xs font-bold tracking-wide text-accent-400 transition-colors duration-300"
          >
            <span
              className="absolute inset-0 -z-10 origin-left scale-x-0 group-hover:scale-x-100 transition-transform duration-300 ease-out bg-accent-400"
              aria-hidden="true"
            />
            <span className="relative group-hover:text-void-950 transition-colors duration-300">Bắt đầu</span>
          </a>
        </div>
      </header>

      <div id="top" />

      {/* ================= HERO — typography as the visual object ================= */}
      <section className="mx-auto max-w-6xl px-5 sm:px-8 pt-16 sm:pt-24 pb-14 sm:pb-16 relative">
        <div className="absolute inset-x-0 top-0 h-[420px] bg-grid pointer-events-none" aria-hidden="true" />
        {/* Ánh sáng chính (key light) — lệch trái, chi phối */}
        <div
          className="atmosphere-drift absolute -left-28 -top-20 w-[480px] h-[480px] rounded-full bg-accent-400/[0.10] blur-[120px] pointer-events-none"
          aria-hidden="true"
        />
        {/* Ánh sáng phụ (fill light) — mờ hơn nhiều, tạo chiều sâu chứ không cạnh tranh */}
        <div
          className="atmosphere-drift absolute right-0 bottom-0 w-[300px] h-[300px] rounded-full bg-azure-500/[0.05] blur-[100px] pointer-events-none"
          style={{ animationDelay: '-9s' }}
          aria-hidden="true"
        />
        {/* Dòng chữ dọc lề phải — cân bằng bất đối xứng bằng chữ, không phải mockup */}
        <span
          className="hidden xl:block absolute right-1 top-1/2 -translate-y-1/2 rotate-90 font-mono text-[10px] tracking-[0.3em] text-ink-700 uppercase whitespace-nowrap select-none pointer-events-none"
          aria-hidden="true"
        >
          Google Drive → Zip · Streaming Engine
        </span>

        <div className="relative max-w-3xl">
          <div className="animate-reveal">
            <SectionKicker meta="Đọc trực tiếp từ Drive">Google Drive → ZIP</SectionKicker>
          </div>
          <h1 className="mt-7 text-[clamp(2.6rem,6.4vw,5.25rem)] leading-[1.05] tracking-tightest">
            <span className="block font-display font-semibold text-white/85 animate-reveal-blur stagger-1">
              Google Drive của bạn,
            </span>
            <span className="block font-display font-extrabold text-gradient animate-reveal-blur stagger-2">
              gói gọn trong một file .zip.
            </span>
          </h1>
          <p className="mt-6 max-w-lg text-ink-400 text-[15px] sm:text-base leading-relaxed animate-reveal stagger-3">
            Dán link folder hoặc file đã chia sẻ công khai. Hệ thống đọc toàn bộ cấu trúc,
            nén theo dòng dữ liệu, và trả về{' '}
            <span className="text-accent-300 font-medium">một file zip duy nhất</span> — không
            giới hạn dung lượng, không cần tài khoản.
          </p>

          <div className="mt-8 h-px w-24 bg-gradient-to-r from-accent-400/60 to-transparent rule-draw stagger-4" aria-hidden="true" />

          <div className="mt-6 flex flex-wrap items-center gap-x-7 gap-y-4 animate-reveal stagger-4">
            <a
              href="#tool"
              className="group relative inline-flex items-center gap-3 overflow-hidden rounded-lg bg-accent-400 hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] active:shadow-[inset_0_2px_6px_rgba(0,0,0,0.25)] px-5 py-3.5 transition-all duration-300"
            >
              <span
                className="pointer-events-none absolute inset-0 -translate-x-[150%] group-hover:translate-x-[150%] transition-transform duration-700 ease-out bg-gradient-to-r from-transparent via-white/40 to-transparent skew-x-[-20deg]"
                aria-hidden="true"
              />
              <span className="relative flex flex-col leading-tight">
                <span className="text-sm font-extrabold text-void-950">Dán link Drive</span>
                <span className="text-[11px] font-medium text-void-950/70">→ một file .zip</span>
              </span>
            </a>
            <a
              href="#spec"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-300 hover:text-accent-400 transition-colors group"
            >
              Cách hoạt động
              <ArrowRight className="w-3.5 h-3.5 transition-transform duration-300 group-hover:translate-x-1" aria-hidden="true" />
            </a>
          </div>
        </div>
      </section>

      {/* ================= TOOL PANEL — the signature interaction ================= */}
      <section id="tool" className="mx-auto max-w-6xl px-5 sm:px-8 pt-2 pb-4 sm:pb-6 -mt-4 sm:-mt-8 scroll-mt-16 relative">
        <div
          className="absolute left-1/2 -translate-x-1/2 -top-4 w-[560px] h-[220px] rounded-full bg-accent-400/[0.06] blur-[90px] pointer-events-none"
          aria-hidden="true"
        />
        <div className="relative surface gradient-border rounded-2xl overflow-hidden animate-reveal">
          {/* Dòng trạng thái duy nhất — thay cho stepper 3 ô */}
          <div className="flex items-center justify-between px-5 sm:px-7 py-3.5 border-b border-white/10">
            <span className="font-mono text-[11px] tracking-wide">
              <span className="text-ink-600">STATUS ›</span>{' '}
              <span key={status.label} className={`font-bold animate-reveal-sm inline-block ${statusToneClass}`}>
                {status.label.toUpperCase()}
              </span>
            </span>
            <span className="hidden sm:inline font-mono text-[10px] text-ink-700 uppercase tracking-widest2">
              Drive → Zip
            </span>
          </div>

          {/* Input row */}
          <div className="p-4 sm:p-7 group">
            <label
              htmlFor="drive-url"
              className="block text-[11px] font-bold tracking-widest2 text-ink-500 group-focus-within:text-accent-400 uppercase mb-3 transition-colors duration-300"
            >
              Link Google Drive
            </label>
            <div className="flex flex-col sm:flex-row gap-3">
              <div
                className={[
                  'relative flex-1 min-w-0 flex items-center rounded-lg border bg-void-950 transition-all duration-300',
                  activeDownload ? 'border-white/10 opacity-60' : 'border-white/10 group-focus-within:border-accent-400/70 group-focus-within:shadow-glow',
                ].join(' ')}
              >
                <Link2 className="w-4 h-4 text-ink-600 group-focus-within:text-accent-400 group-focus-within:scale-110 ml-4 shrink-0 transition-all duration-300" aria-hidden="true" />
                <input
                  id="drive-url"
                  ref={urlInputRef}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://drive.google.com/drive/folders/..."
                  aria-label="Link Google Drive"
                  aria-invalid={!!error}
                  aria-describedby={error ? 'url-error' : undefined}
                  className="w-full bg-transparent border-0 pl-3 pr-10 py-3.5 text-sm text-white placeholder-ink-600 focus:outline-none font-mono"
                  onKeyDown={(e) => e.key === 'Enter' && !activeDownload && handlePreview()}
                  disabled={!!activeDownload}
                />
                {pasteSupported && !activeDownload && (
                  <button
                    onClick={handlePaste}
                    title="Dán từ clipboard"
                    aria-label="Dán link từ clipboard"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-500 hover:text-accent-400 transition-colors p-1.5 rounded-md hover:bg-white/5"
                  >
                    <ClipboardPaste className="w-4 h-4" />
                  </button>
                )}
              </div>
              {activeDownload ? (
                <button
                  onClick={resetToIdle}
                  className="shrink-0 rounded-lg border border-ink-600 hover:border-white/40 active:scale-[0.98] px-6 py-3.5 text-sm font-bold text-ink-300 hover:text-white transition-all duration-200"
                >
                  Link khác
                </button>
              ) : (
                <button
                  onClick={handlePreview}
                  disabled={stage === 'previewing'}
                  className="group/btn relative overflow-hidden shrink-0 rounded-lg bg-accent-400 hover:shadow-glow-sm hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-none disabled:hover:translate-y-0 active:scale-[0.98] active:shadow-[inset_0_2px_6px_rgba(0,0,0,0.25)] px-6 py-3.5 text-sm font-extrabold text-void-950 transition-all duration-300 flex items-center justify-center gap-2"
                >
                  <span
                    className="pointer-events-none absolute inset-0 -translate-x-[150%] group-hover/btn:translate-x-[150%] transition-transform duration-700 ease-out bg-gradient-to-r from-transparent via-white/40 to-transparent skew-x-[-20deg]"
                    aria-hidden="true"
                  />
                  {stage === 'previewing' ? (
                    <><Loader2 className="w-4 h-4 animate-spin relative" /> <span className="relative">Đang quét</span></>
                  ) : (
                    <><Search className="w-4 h-4 relative" /> <span className="relative">Quét link</span></>
                  )}
                </button>
              )}
            </div>

            {stage === 'previewing' && (
              <div className="mt-5 flex items-center gap-4 animate-reveal-sm">
                <div className="relative w-8 h-8 shrink-0 flex items-center justify-center">
                  <span className="absolute inset-0 rounded-full border border-accent-400/50 animate-ping [animation-duration:1.8s]" aria-hidden="true" />
                  <span className="absolute inset-0 rounded-full border border-accent-400/25 animate-ping [animation-duration:1.8s] [animation-delay:0.5s]" aria-hidden="true" />
                  <Search className="w-3.5 h-3.5 text-accent-400 relative" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm text-white font-medium flex items-center">
                    Đang phân tích cấu trúc thư mục
                    <span className="inline-flex gap-0.5 ml-1.5" aria-hidden="true">
                      <span className="w-1 h-1 rounded-full bg-accent-400 loading-dot" style={{ animationDelay: '0ms' }} />
                      <span className="w-1 h-1 rounded-full bg-accent-400 loading-dot" style={{ animationDelay: '150ms' }} />
                      <span className="w-1 h-1 rounded-full bg-accent-400 loading-dot" style={{ animationDelay: '300ms' }} />
                    </span>
                  </p>
                  <p className="text-[11px] text-ink-500 font-mono mt-0.5">Đang liệt kê từng file và thư mục con</p>
                </div>
              </div>
            )}

            {error && (
              <div
                id="url-error"
                role="alert"
                aria-live="polite"
                className="mt-5 border-l-2 border-signal-500 pl-4 py-1 flex flex-col gap-0.5 animate-reveal-sm"
              >
                <span className="text-[10px] font-bold tracking-widest2 text-signal-500 uppercase">Lỗi</span>
                <span className="text-sm text-ink-200">{error}</span>
              </div>
            )}
          </div>

          {/* Preview panel */}
          {preview && !activeDownload && (
            <div className="border-t border-white/10 p-4 sm:p-7 animate-reveal">
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    {editingName ? (
                      <input
                        autoFocus
                        value={outputBase}
                        onChange={(e) => setOutputBase(e.target.value)}
                        onBlur={() => setEditingName(false)}
                        onKeyDown={(e) => e.key === 'Enter' && setEditingName(false)}
                        aria-label="Tên file đầu ra"
                        className="w-full bg-transparent border-0 border-b border-accent-400 pb-1 text-lg sm:text-xl font-display font-bold text-white focus:outline-none font-mono"
                      />
                    ) : (
                      <button
                        onClick={() => setEditingName(true)}
                        className="group flex items-center gap-2 text-white font-display font-bold text-lg sm:text-xl truncate max-w-full hover:text-accent-400 transition-colors"
                        title="Đổi tên file tải xuống"
                        aria-label={`Đổi tên file, hiện tại: ${outputBase || preview.name}`}
                      >
                        <span className="truncate">{outputBase || preview.name}</span>
                        <Pencil className="w-3.5 h-3.5 opacity-40 group-hover:opacity-100 shrink-0" aria-hidden="true" />
                      </button>
                    )}
                    <span className="inline-flex items-center rounded-sm border border-accent-400/30 px-1.5 py-0.5 text-[9px] font-bold tracking-widest2 text-accent-400 uppercase shrink-0">
                      Công khai
                    </span>
                  </div>

                  <div className="flex items-baseline gap-5 sm:gap-7 mt-4">
                    <DataStat value={countFiles.toLocaleString('vi-VN')} label="File" size="lg" />
                    {preview.totalSize ? (
                      <>
                        <span className="h-8 w-px bg-white/10 self-end mb-1" aria-hidden="true" />
                        <DataStat value={formatBytes(countBytes)} label="Dung lượng" size="lg" />
                      </>
                    ) : null}
                  </div>

                  <div className="mt-3 space-y-1">
                    {scannedAt && (
                      <p className="text-[11px] text-ink-500 font-mono">Quét lúc {formatTimestamp(scannedAt)}</p>
                    )}
                    {preview.unknownSizeCount ? (
                      <p className="text-[11px] text-ink-500 font-mono">
                        {preview.unknownSizeCount} Google Docs — chưa rõ dung lượng
                      </p>
                    ) : null}
                    {preview.exceedsLimit && (
                      <p className="text-[11px] text-signal-500 font-mono flex items-start gap-1.5 max-w-md pt-1">
                        Vượt giới hạn {formatBytes(preview.sizeLimit)} của server miễn phí — chia nhỏ folder rồi tải riêng.
                        {directAvailable && ' Hoặc dùng "Tải trực tiếp" — không bị giới hạn này.'}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex sm:flex-col gap-2 shrink-0 w-full sm:w-auto">
                  <button
                    onClick={handleDownload}
                    disabled={preview.exceedsLimit}
                    className="group/dl relative overflow-hidden flex-1 sm:flex-none rounded-lg bg-accent-400 hover:shadow-glow hover:-translate-y-0.5 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:shadow-none disabled:hover:translate-y-0 active:scale-[0.97] active:shadow-[inset_0_2px_6px_rgba(0,0,0,0.25)] px-5 py-3 text-xs font-extrabold uppercase tracking-wide text-void-950 transition-all duration-300 flex items-center justify-center gap-2 whitespace-nowrap"
                  >
                    <span
                      className="pointer-events-none absolute inset-0 -translate-x-[150%] group-hover/dl:translate-x-[150%] transition-transform duration-700 ease-out bg-gradient-to-r from-transparent via-white/40 to-transparent skew-x-[-20deg]"
                      aria-hidden="true"
                    />
                    <Download className="w-3.5 h-3.5 relative" aria-hidden="true" />
                    <span className="relative">{preview.isFolder ? 'Tải .zip' : 'Tải xuống'}</span>
                  </button>
                  {directAvailable && (
                    <button
                      onClick={handleDownloadDirect}
                      title={
                        fsaAvailable
                          ? 'Tải thẳng từ Google Drive, không qua server — ráp thành 1 file .zip ngay trên máy.'
                          : 'Tải thẳng từ Google Drive, không qua server — ra nhiều file rời.'
                      }
                      className="flex-1 sm:flex-none rounded-lg border border-ink-600 hover:border-accent-400/60 hover:text-accent-400 active:scale-[0.97] px-5 py-3 text-xs font-bold uppercase tracking-wide text-ink-300 transition-all duration-200 flex items-center justify-center gap-2 whitespace-nowrap"
                    >
                      Trực tiếp
                    </button>
                  )}
                </div>
              </div>

              {preview.files.length > 0 && preview.files.length <= 200 && (
                <div className="mt-5 border-t border-white/10 pt-4">
                  <button
                    onClick={() => setShowFileList((v) => !v)}
                    className="flex items-center gap-1.5 text-[11px] font-bold tracking-wide uppercase text-ink-500 hover:text-ink-200 transition-colors"
                    aria-expanded={showFileList}
                  >
                    {showFileList ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    {showFileList ? 'Ẩn danh sách' : `Danh sách file (${preview.files.length})`}
                  </button>
                  {showFileList && (
                    <div className="mt-3 max-h-56 overflow-y-auto animate-reveal-sm">
                      {preview.files.map((f, i) => (
                        <div
                          key={f.id}
                          className={[
                            'flex items-center justify-between gap-3 py-2.5 hover:bg-white/[0.02] transition-colors px-1',
                            i !== 0 ? 'border-t border-white/[0.06]' : '',
                          ].join(' ')}
                        >
                          <span className="text-[12px] text-ink-400 font-mono truncate flex-1">{f.path}</span>
                          {f.size ? (
                            <span className="text-[10px] text-ink-600 font-mono tabular-nums shrink-0">{formatBytes(f.size)}</span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Active download panel */}
          {activeDownload && activeEntry && (
            <div
              className={[
                'relative border-t p-4 sm:p-7 animate-reveal transition-colors duration-700',
                isDone ? 'border-accent-400/25' : 'border-white/10',
              ].join(' ')}
            >
              {isDone && (
                <div className="absolute inset-0 bg-gradient-to-b from-accent-400/[0.04] to-transparent pointer-events-none" aria-hidden="true" />
              )}
              <div className="relative">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5 flex-wrap mb-1">
                      <p className="text-white font-display font-bold text-base sm:text-lg truncate">{activeEntry.name}</p>
                      {isDone && (
                        <span className="glow-pulse-once animate-reveal-sm inline-flex items-center gap-1 rounded-full border border-accent-400/40 bg-accent-400/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-400">
                          <svg viewBox="0 0 24 24" className="w-3 h-3" aria-hidden="true">
                            <path d="M4 12l5 5L20 7" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="check-draw" />
                          </svg>
                          Đã đóng gói
                        </span>
                      )}
                    </div>
                    <p
                      className="text-xs text-ink-400 font-mono truncate"
                      aria-live="polite"
                      aria-atomic="true"
                    >
                      {(() => {
                        const { kind } = activeDownload;
                        const st = liveProgress?.status;
                        if (kind === 'direct') {
                          if (st === 'done') return fsaAvailable
                            ? `Đã ráp xong 1 file .zip từ ${liveProgress!.totalFiles} file — tải thẳng từ Google.`
                            : `Đã chuyển ${liveProgress!.totalFiles} file thẳng từ Google, không qua server.`;
                          return liveProgress?.currentFileName
                            ? (fsaAvailable ? `Đang ráp zip: ${liveProgress.currentFileName}` : `Đang chuyển: ${liveProgress.currentFileName}`)
                            : 'Đang bắt đầu tải trực tiếp...';
                        }
                        if (kind === 'file') return 'Đang tải file — kiểm tra thanh tải của trình duyệt.';
                        if (st === 'queued') return liveProgress?.queuePosition
                          ? `Đang xếp hàng — vị trí ${liveProgress.queuePosition}/${liveProgress.queueLength}`
                          : 'Đang xếp hàng...';
                        if (st === 'done') return 'Nén xong. Đang ghi ra ổ đĩa...';
                        if (st === 'error') return liveProgress?.errorMessage ?? 'Có lỗi xảy ra.';
                        return liveProgress?.currentFileName
                          ? `Đang nén: ${liveProgress.currentFileName}`
                          : 'Đang xử lý...';
                      })()}
                    </p>
                  </div>
                  <DataStat value={formatElapsed(elapsed)} label="Elapsed" size="lg" />
                </div>

                {liveProgress?.status === 'queued' && (
                  <div className="mt-4 flex items-center gap-2 font-mono text-[11px] text-accent-400">
                    <Loader2 className="w-3 h-3 animate-spin shrink-0" aria-hidden="true" />
                    Hệ thống đang bận — giữ tab này mở, lượt của bạn sẽ tự động bắt đầu khi tới lượt.
                  </div>
                )}

                {liveProgress && liveProgress.status !== 'unknown' && liveProgress.status !== 'queued' && liveProgress.totalFiles > 0 && (
                  <div className="mt-4" role="progressbar" aria-valuenow={progressPct} aria-valuemin={0} aria-valuemax={100}>
                    <div className="h-1.5 w-full rounded-full bg-white/[0.06] overflow-hidden">
                      <div
                        className="relative h-full rounded-full bg-gradient-to-r from-accent-500 via-accent-400 to-accent-300 transition-[width] duration-500 ease-out overflow-hidden"
                        style={{ width: `${progressPct}%` }}
                      >
                        {!isDone && <div className="absolute inset-0 progress-sheen" aria-hidden="true" />}
                      </div>
                    </div>
                    <p className="text-[11px] text-ink-500 mt-2 flex items-center justify-between font-mono tabular-nums">
                      <span>
                        {liveProgress.completedFiles.toLocaleString('vi-VN')} / {liveProgress.totalFiles.toLocaleString('vi-VN')} file
                        <span className="text-ink-600"> — {progressPct}%</span>
                      </span>
                      {liveProgress.skipped.length > 0 && (
                        <span className="text-signal-500">{liveProgress.skipped.length} lỗi</span>
                      )}
                    </p>
                  </div>
                )}

                {liveProgress && liveProgress.skipped.length > 0 && (
                  <p className="text-[11px] text-signal-500 font-mono mt-3 border-l-2 border-signal-500/40 pl-3">
                    {activeDownload.kind === 'direct'
                      ? `${liveProgress.skipped.length} file không tải được: ${liveProgress.skipped.slice(0, 3).map((s) => s.name).join(', ')}${liveProgress.skipped.length > 3 ? '...' : ''}`
                      : <>Một số file không tải được — chi tiết trong <code>_file_bi_loi.txt</code> bên trong zip.</>}
                  </p>
                )}

                <p className="text-[11px] text-ink-500 font-mono mt-4">
                  Bắt đầu lúc {formatTimestamp(activeEntry.startedAt)}
                </p>
                <p className="text-xs text-ink-400 mt-1.5 max-w-lg">
                  {activeDownload.kind === 'direct'
                    ? fsaAvailable
                      ? 'Đang ghi thẳng vào file .zip bạn đã chọn — giữ tab này mở đến khi xong.'
                      : 'Từng file đang được chuyển vào thư mục Downloads — giữ tab mở đến khi xong.'
                    : activeDownload.kind === 'file'
                      ? 'File đang tải về — kiểm tra thanh tải phía dưới của trình duyệt.'
                      : 'Quá trình nén chạy ngầm trên server — file sẽ tự tải về khi xong. Folder lớn có thể mất vài phút.'}
                </p>

                {notifPermission === 'default' && activeDownload.kind !== 'file' && (
                  <button
                    onClick={requestNotifPermission}
                    className="mt-4 flex items-center gap-1.5 text-[11px] font-semibold text-ink-400 hover:text-accent-400 transition-colors"
                  >
                    <Bell className="w-3.5 h-3.5" aria-hidden="true" />
                    Bật thông báo khi tải xong
                  </button>
                )}

                <div className="mt-5 flex gap-2">
                  {!isDone && activeDownload.kind === 'direct' && (
                    <button
                      onClick={handleCancelDownload}
                      className="flex-1 rounded-lg border border-signal-500/40 hover:border-signal-500 hover:bg-signal-500/[0.06] text-signal-500 text-[11px] font-bold uppercase tracking-wide py-2.5 transition-colors flex items-center justify-center gap-1.5"
                    >
                      <X className="w-3.5 h-3.5" aria-hidden="true" /> Huỷ tải
                    </button>
                  )}
                  <button
                    onClick={handleMarkDone}
                    className={[
                      'flex-1 rounded-lg border text-[11px] font-bold uppercase tracking-wide py-2.5 transition-colors duration-300',
                      isDone
                        ? 'border-accent-400/40 text-accent-400 hover:bg-accent-400/10'
                        : 'border-ink-700 text-ink-300 hover:border-white/30 hover:text-white',
                    ].join(' ')}
                  >
                    {isDone ? 'Đóng lại' : 'Đóng theo dõi'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ================= SPEC — editorial, không phải lưới card ================= */}
      <section
        id="spec"
        ref={specRef}
        className={`reveal-on-scroll ${specVisible ? 'is-visible' : ''} mx-auto max-w-6xl px-5 sm:px-8 py-20 sm:py-28 scroll-mt-16 relative overflow-hidden`}
      >
        <span
          className={[
            'absolute right-0 top-0 select-none pointer-events-none font-display font-extrabold leading-none text-white/[0.035] text-[160px] sm:text-[240px] transition-all duration-700 ease-out',
            specVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-90',
          ].join(' ')}
          style={{ transitionDelay: specVisible ? '120ms' : '0ms' }}
          aria-hidden="true"
        >
          01
        </span>
        <div className="relative">
          <SectionKicker meta="Streaming pipeline" visible={specVisible}>Thông số kỹ thuật</SectionKicker>
          <h2 className="mt-6 text-3xl sm:text-[2.75rem] font-display font-extrabold tracking-tightest max-w-xl leading-[1.08]">
            <span className="text-white">Xây dựng để xử lý folder thật,</span>{' '}
            <span className="text-ink-400 font-semibold">không phải để demo.</span>
          </h2>
          <div className="mt-12 border-t border-white/10">
            {SPECS.map((f, i) => (
              <div
                key={f.title}
                className={`row-reveal ${specVisible ? 'is-visible' : ''} group grid sm:grid-cols-[2.5rem_1fr_auto] gap-3 sm:gap-8 py-7 sm:py-8 items-start sm:items-center border-b border-white/10`}
                style={{ transitionDelay: specVisible ? `${120 + i * 90}ms` : '0ms' }}
              >
                <span className="font-mono text-xs text-accent-400/70 pt-1 sm:pt-0">{pad2(i + 1)}</span>
                <div>
                  <p className="text-white font-bold text-lg sm:text-xl mb-1.5 group-hover:text-accent-300 transition-colors duration-300">
                    {f.title}
                  </p>
                  <p className="text-ink-400 text-sm leading-relaxed max-w-md">{f.desc}</p>
                </div>
                <span className="inline-flex sm:shrink-0 w-fit rounded-sm border border-white/15 group-hover:border-accent-400/50 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-ink-400 group-hover:text-accent-400 transition-colors duration-300">
                  {f.tag}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ================= MANIFESTO — $ status ================= */}
      <section
        id="manifesto"
        ref={manifestoRef}
        className={`reveal-on-scroll ${manifestoVisible ? 'is-visible' : ''} mx-auto max-w-6xl px-5 sm:px-8 py-4 sm:py-6 pb-20 sm:pb-28 scroll-mt-16 relative`}
      >
        <SectionKicker meta="Không thu thập dữ liệu" visible={manifestoVisible}>Cam kết sản phẩm</SectionKicker>
        <h2 className="mt-6 text-3xl sm:text-[2.75rem] font-display font-extrabold tracking-tightest text-white max-w-xl leading-[1.08]">
          Không tài khoản. Không dữ liệu bị giữ lại.
        </h2>

        <div
          className="atmosphere-drift absolute left-8 top-1/3 w-[280px] h-[280px] rounded-full bg-accent-400/[0.04] blur-[100px] pointer-events-none"
          style={{ animationDelay: '-4s' }}
          aria-hidden="true"
        />

        <div
          className={[
            'relative mt-10 surface gradient-border rounded-2xl overflow-hidden max-w-2xl transition-all duration-500 ease-out',
            manifestoVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-[0.97]',
          ].join(' ')}
          style={{ transitionDelay: manifestoVisible ? '150ms' : '0ms' }}
        >
          {/* Thanh tiêu đề cửa sổ macOS thật — đèn + tiêu đề, căn trái, có gap chuẩn */}
          <div className="flex items-center gap-4 px-5 py-3.5 border-b border-white/10">
            <TrafficLights />
            <span className="font-mono text-[11px] text-ink-500">
              $ status
              <span className="inline-block w-[6px] h-[13px] bg-ink-600 ml-1.5 align-middle animate-caret" aria-hidden="true" />
            </span>
          </div>
          <div className="p-5 sm:p-7 space-y-5">
            {MANIFESTO.map((m, i) => (
              <div
                key={m.key}
                className={`line-reveal ${manifestoVisible ? 'is-visible' : ''}`}
                style={{ transitionDelay: manifestoVisible ? `${260 + i * 90}ms` : '0ms' }}
              >
                <p className="font-mono text-[13px] sm:text-sm">
                  <span className="text-ink-500">$ {m.key}</span>{' '}
                  <span className="text-ink-600">→</span>{' '}
                  <span className="text-accent-400 font-bold text-glow">{m.value}</span>
                </p>
                <p className="font-mono text-[11px] text-ink-600 mt-1 pl-3.5"># {m.comment}</p>
              </div>
            ))}
          </div>
        </div>

        <p className="mt-6 max-w-xl border-l-2 border-accent-400/50 pl-4 text-ink-300 text-sm leading-relaxed">
          Mục tiêu duy nhất: một link vào, một file zip ra — không phân tích hành vi, không
          lưu vết sau khi hoàn tất.
        </p>
      </section>

      {/* ================= HISTORY ================= */}
      {history.length > 0 && (
        <section
          id="log"
          ref={historyRef}
          className={`reveal-on-scroll ${historyVisible ? 'is-visible' : ''} mx-auto max-w-6xl px-5 sm:px-8 pb-20 sm:pb-28 scroll-mt-16`}
        >
          <button
            onClick={() => setShowHistory((v) => !v)}
            className="flex items-center gap-4 w-full text-left mb-5"
            aria-expanded={showHistory}
          >
            <SectionKicker visible={historyVisible}>{`Nhật ký (${history.length})`}</SectionKicker>
            {showHistory ? <ChevronUp className="w-4 h-4 text-ink-500 shrink-0" /> : <ChevronDown className="w-4 h-4 text-ink-500 shrink-0" />}
          </button>
          {showHistory && (
            <div className="border-t border-white/10">
              {history.map((h, i) => (
                <div
                  key={h.id}
                  className="animate-reveal-sm flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 sm:gap-3 py-3.5 border-b border-white/[0.06] hover:bg-white/[0.02] transition-colors px-1"
                  style={{ animationDelay: `${i * 60}ms` }}
                >
                  <div className="min-w-0 flex items-center gap-3">
                    <span className="font-mono text-[10px] text-ink-600 shrink-0">{pad2(i + 1)}</span>
                    <p className="text-ink-200 text-sm truncate">{h.name}</p>
                  </div>
                  <div className="flex items-center gap-4 shrink-0 pl-6 sm:pl-0">
                    <span className="font-mono text-[11px] text-ink-500 tabular-nums">
                      {h.count} file{h.size ? ` · ${formatBytes(h.size)}` : ''}
                    </span>
                    <span className="font-mono text-[11px] text-ink-600 tabular-nums hidden sm:inline">
                      {formatTimestamp(h.startedAt)}
                    </span>
                    <span
                      className={[
                        'rounded-sm text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 border',
                        h.finishedAt ? 'border-accent-400/30 bg-accent-400/10 text-accent-400' : 'border-white/15 text-ink-400',
                      ].join(' ')}
                    >
                      {h.finishedAt ? 'Xong' : 'Đang tải'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ================= FOOTER ================= */}
      <footer ref={footerRef} className={`reveal-on-scroll ${footerVisible ? 'is-visible' : ''} border-t border-white/10`}>
        <div className="mx-auto max-w-6xl px-5 sm:px-8 py-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-accent-400 rounded-sm" aria-hidden="true" />
            <span className="font-display text-sm font-extrabold text-white">
              Zippy<span className="text-accent-400">Drive</span>
            </span>
            <span className="text-ink-600 text-xs ml-2 hidden sm:inline">— Google Drive vào một file .zip.</span>
          </div>
          <p className="text-[11px] text-ink-600 leading-relaxed max-w-md">
            Yêu cầu link có quyền chia sẻ <span className="text-ink-400">«Anyone with the link»</span>.
            Google Docs, Sheets, Slides tự động chuyển sang .docx, .xlsx, .pptx.
          </p>
        </div>
      </footer>
    </main>
  );
}
