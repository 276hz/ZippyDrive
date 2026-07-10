'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Link2,
  Search,
  Download,
  CheckCircle2,
  Loader2,
  Clock,
  History,
  AlertTriangle,
  ClipboardPaste,
  FileArchive,
  Pencil,
  Zap,
  FolderTree,
  RefreshCw,
  Globe2,
  Tag,
} from 'lucide-react';

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

type Stage = 'idle' | 'previewing' | 'ready' | 'error';

const STATUS_MESSAGES = [
  'Đang bắt sóng Google Drive...',
  'Đang lượm từng file một...',
  'Đang nhét hết vào zip nè...',
  'Đang bắn dữ liệu về máy bạn...',
];

const FEATURES = [
  {
    icon: Zap,
    title: 'To mấy cũng gánh',
    desc: 'Nén tới đâu bắn tới đó, không ôm hết vào RAM — folder bự cỡ nào cũng không ngán.',
  },
  {
    icon: FolderTree,
    title: 'Y chang bản gốc',
    desc: 'Thư mục con cháu gì cũng giữ nguyên như trên Drive, khỏi lo bị xáo trộn lung tung.',
  },
  {
    icon: RefreshCw,
    title: 'Tự động đổi đuôi',
    desc: 'Docs, Sheets, Slides tự lột xác thành .docx/.xlsx/.pptx, mở bằng Office ngon lành.',
  },
  {
    icon: Globe2,
    title: 'Chạy mượt mọi nơi',
    desc: 'Chrome, Safari, Firefox, Edge — máy tính hay điện thoại đều êm re.',
  },
];

/** Bộ đếm số chạy mượt (ease-out) — dùng cho số file / dung lượng khi có kết quả quét */
function useCountUp(target: number, duration = 700) {
  const [value, setValue] = useState(0);
  const fromRef = useRef(0);

  useEffect(() => {
    const reduceMotion =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      setValue(target);
      fromRef.current = target;
      return;
    }
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

function stepState(current: Stage, target: 'input' | 'preview' | 'download', hasPreview: boolean, hasActive: boolean) {
  if (target === 'input') return hasPreview || hasActive ? 'done' : 'active';
  if (target === 'preview') {
    if (hasActive) return 'done';
    if (hasPreview) return 'active';
    return current === 'previewing' ? 'active' : 'pending';
  }
  if (hasActive) return 'active';
  if (hasPreview) return 'pending';
  return 'pending';
}

/** Con dấu "ĐÃ ĐÓNG GÓI" — khoảnh khắc dấu hiệu duy nhất của trang, chỉ xuất hiện
 * khi server đã nén xong hẳn zip (liveProgress.status === 'done'). */
function PackedStamp() {
  return (
    <div className="animate-stamp-down inline-flex items-center gap-1.5 rounded-md border-2 border-seal-400/70 px-2.5 py-1 -rotate-[8deg] shrink-0">
      <CheckCircle2 className="w-3.5 h-3.5 text-seal-400" />
      <span className="font-mono text-[10px] font-bold tracking-[0.12em] text-seal-400 uppercase">
        Đã đóng gói
      </span>
    </div>
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

  const [activeDownload, setActiveDownload] = useState<{ historyId: string; kind: 'zip' | 'file' } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [liveProgress, setLiveProgress] = useState<LiveProgress | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [pasteSupported, setPasteSupported] = useState(false);
  const urlInputRef = useRef<HTMLInputElement>(null);

  const countFiles = useCountUp(preview?.totalCount ?? 0);
  const countBytes = useCountUp(preview?.totalSize ?? 0);

  useEffect(() => {
    setPasteSupported(typeof navigator !== 'undefined' && !!navigator.clipboard?.readText);
  }, []);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (activeDownload) {
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [activeDownload]);

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setUrl(text.trim());
    } catch {
      // Trình duyệt chặn quyền đọc clipboard — bỏ qua, người dùng vẫn dán tay được (Ctrl/Cmd+V)
    }
  }

  async function handlePreview() {
    setError('');
    setPreview(null);
    if (!url.trim()) {
      setError('Dán link Google Drive vào ô bên trên đã nhé.');
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
      if (data.totalCount === 0) throw new Error('Folder rỗng hoặc không có file nào công khai.');
      setPreview(data);
      setScannedAt(new Date());
      const { base } = splitExt(data.name || 'drive-download');
      setOutputBase(data.isFolder ? data.name || 'drive-download' : base);
      setStage('ready');
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
      setError('Folder vượt giới hạn dung lượng cho phép — hãy chia nhỏ thành các folder con rồi tải riêng.');
      return;
    }

    const isSingleFile = !preview.isFolder && preview.files.length === 1;
    const { ext } = isSingleFile ? splitExt(preview.files[0].path) : { ext: '.zip' };
    const finalName = `${outputBase.trim() || 'drive-download'}${ext}`;

    // Không cần kiểm tra "server có bận không" nữa — giờ server tự XẾP HÀNG thay vì
    // từ chối (xem lib/download-lock.ts). Cứ điều hướng bình thường; nếu đông người,
    // trạng thái "Đang xếp hàng" sẽ tự hiện qua kênh tiến độ SSE bên dưới.
    const token = genToken();
    const endpoint = isSingleFile
      ? `/api/proxy?${new URLSearchParams({
          id: preview.files[0].id,
          mime: preview.files[0].mimeType,
          name: finalName,
          ...(preview.resourceKey ? { key: preview.resourceKey } : {}),
        }).toString()}`
      : `/api/download?${new URLSearchParams({
          url,
          name: outputBase.trim() || 'drive-download',
          token,
        }).toString()}`;

    const historyId = `${Date.now()}`;
    setHistory((h) => [
      {
        id: historyId,
        name: finalName,
        count: preview.totalCount,
        size: preview.totalSize,
        startedAt: new Date(),
        finishedAt: null,
      },
      ...h,
    ]);
    setElapsed(0);
    setLiveProgress(
      isSingleFile ? null : { totalFiles: preview.totalCount, completedFiles: 0, currentFileName: null, skipped: [], status: 'queued' }
    );
    setActiveDownload({ historyId, kind: isSingleFile ? 'file' : 'zip' });

    if (!isSingleFile) {
      closeProgressStream();
      const es = new EventSource(`/api/progress?token=${encodeURIComponent(token)}`);
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as LiveProgress;
          setLiveProgress(data);
        } catch {
          // bỏ qua payload lỗi định dạng
        }
      };
      es.onerror = () => {
        // Kết nối SSE rớt (ví dụ server ngủ lại hoặc mạng chập chờn) — không coi là
        // lỗi tải, file zip vẫn tiếp tục tải bình thường qua request GET gốc, chỉ
        // là không còn cập nhật % tiến độ theo thời gian thực nữa.
        closeProgressStream();
      };
      eventSourceRef.current = es;
    }

    window.location.href = endpoint;
  }

  function handleMarkDone() {
    if (!activeDownload) return;
    closeProgressStream();
    setHistory((h) =>
      h.map((entry) => (entry.id === activeDownload.historyId ? { ...entry, finishedAt: new Date() } : entry))
    );
    setActiveDownload(null);
    setLiveProgress(null);
  }

  const hasPreview = !!preview;
  const hasActive = !!activeDownload;
  const statusMsg = STATUS_MESSAGES[Math.floor(elapsed / 3) % STATUS_MESSAGES.length];
  const activeEntry = history.find((h) => h.id === activeDownload?.historyId);

  const steps: { key: 'input' | 'preview' | 'download'; label: string; icon: any }[] = [
    { key: 'input', label: 'Dán link', icon: Link2 },
    { key: 'preview', label: 'Xem trước', icon: Search },
    { key: 'download', label: 'Tải xuống', icon: Download },
  ];

  return (
    <main className="min-h-screen flex flex-col items-center px-4 py-12 sm:py-16 relative overflow-hidden font-sans">
      {/* Vân giấy kraft nền — rất mảnh, chỉ để tạo chất liệu, không gây rối mắt */}
      <div className="absolute inset-0 bg-grid" />

      <div className="w-full max-w-2xl relative">
        <div className="text-center mb-8 animate-fade-in">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-kraft-500/35 bg-kraft-500/[0.06] text-kraft-400 text-[10px] font-mono font-semibold tracking-[0.14em] uppercase mb-5">
            <Tag className="w-3 h-3" />
            Free 100% · Không đăng nhập · Không drama
          </div>
          <div className="flex items-center justify-center gap-2.5 mb-4">
            <div className="w-9 h-9 rounded-lg bg-stamp-500 flex items-center justify-center shadow-lg shadow-stamp-500/20 -rotate-3">
              <FileArchive className="w-5 h-5 text-carbon-950" />
            </div>
            <span className="text-xl font-display font-extrabold text-white tracking-tight">ZippyDrive</span>
          </div>
          <h1 className="text-3xl sm:text-[2.75rem] font-display font-extrabold tracking-tight text-white leading-[1.1]">
            Hốt trọn folder Google Drive
            <br />
            dồn vào đúng <span className="text-kraft-400">1 file .zip</span>
          </h1>
          <p className="mt-4 text-ink-300 text-sm sm:text-base max-w-lg mx-auto">
            Dán link vô, ngó qua 1 phát cho chắc, bấm nút là tải sạch banh về máy —
            không giới hạn dung lượng, khỏi cài thêm gì cho mệt.
          </p>
        </div>

        {/* Dải tính năng nổi bật */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-8 animate-fade-in">
          {FEATURES.map((f, idx) => (
            <div
              key={f.title}
              className={`animate-slide-up stagger-${idx + 1} rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 hover:border-kraft-500/25 hover:bg-white/[0.04] transition-colors duration-200`}
            >
              <f.icon className="w-4 h-4 text-kraft-400 mb-1.5" />
              <p className="text-[11px] font-semibold text-ink-200 leading-tight">{f.title}</p>
              <p className="text-[10px] text-ink-500 leading-snug mt-0.5 hidden sm:block">{f.desc}</p>
            </div>
          ))}
        </div>

        {/* Stepper */}
        <div className="flex items-center justify-center gap-2 mb-6 animate-fade-in">
          {steps.map((s, idx) => {
            const state = stepState(stage, s.key, hasPreview, hasActive);
            const Icon = state === 'done' ? CheckCircle2 : s.icon;
            return (
              <div key={s.key} className="flex items-center">
                <div
                  className={[
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all duration-300',
                    state === 'active'
                      ? 'bg-kraft-500/10 border-kraft-500/40 text-kraft-400'
                      : state === 'done'
                        ? 'bg-seal-500/10 border-seal-500/30 text-seal-400'
                        : 'bg-white/[0.03] border-white/10 text-ink-500',
                  ].join(' ')}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {s.label}
                </div>
                {idx < steps.length - 1 && <div className="w-6 sm:w-10 h-px bg-white/10 mx-1" />}
              </div>
            );
          })}
        </div>

        {/* Thẻ nhập link — bo dáng như 1 nhãn vận đơn: viền kraft mảnh, góc vuông hơn */}
        <div className="bg-carbon-900/70 border border-white/[0.08] rounded-xl p-5 sm:p-6 backdrop-blur-sm shadow-2xl shadow-black/30 animate-slide-up">
          <label className="block text-sm text-ink-300 mb-2 font-medium">Link Google Drive</label>
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <input
                ref={urlInputRef}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://drive.google.com/drive/folders/..."
                aria-label="Link Google Drive"
                aria-invalid={!!error}
                className="w-full rounded-lg bg-carbon-950/70 border border-white/10 pl-4 pr-10 py-3 text-sm text-ink-100 placeholder-ink-600 focus:outline-none focus:ring-1 focus:ring-kraft-500 focus:border-kraft-500/60 transition-all font-mono"
                onKeyDown={(e) => e.key === 'Enter' && handlePreview()}
              />
              {pasteSupported && (
                <button
                  onClick={handlePaste}
                  title="Dán từ clipboard"
                  aria-label="Dán link từ clipboard"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-500 hover:text-kraft-400 transition-colors p-2.5 rounded-md hover:bg-white/5 min-w-[36px] min-h-[36px] flex items-center justify-center"
                >
                  <ClipboardPaste className="w-4 h-4" />
                </button>
              )}
            </div>
            <button
              onClick={handlePreview}
              disabled={stage === 'previewing'}
              className="rounded-lg bg-kraft-500 hover:bg-kraft-400 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed px-5 py-3 text-sm font-semibold text-carbon-950 transition-all duration-150 flex items-center justify-center gap-2 whitespace-nowrap shadow-lg shadow-kraft-500/15"
            >
              {stage === 'previewing' ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Đang quét...
                </>
              ) : (
                'Xem trước'
              )}
            </button>
          </div>

          {stage === 'previewing' && (
            <div className="mt-4 h-16 rounded-lg animate-shimmer border border-white/5" />
          )}

          {error && (
            <div
              role="alert"
              aria-live="polite"
              className="mt-4 text-sm text-stamp-400 bg-stamp-500/[0.08] border border-stamp-500/25 rounded-lg px-4 py-3 flex items-start gap-2 animate-slide-up"
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {preview && !activeDownload && (
            <div className="mt-5 rounded-lg border border-white/10 bg-carbon-950/50 p-4 animate-scale-in">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {editingName ? (
                    <input
                      autoFocus
                      value={outputBase}
                      onChange={(e) => setOutputBase(e.target.value)}
                      onBlur={() => setEditingName(false)}
                      onKeyDown={(e) => e.key === 'Enter' && setEditingName(false)}
                      className="w-full bg-carbon-800 border border-kraft-500/40 rounded-md px-2 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-kraft-500 font-mono"
                    />
                  ) : (
                    <button
                      onClick={() => setEditingName(true)}
                      className="group flex items-center gap-1.5 text-white font-medium truncate max-w-[240px] sm:max-w-xs hover:text-kraft-400 transition-colors py-1"
                      title="Bấm để đổi tên file khi tải"
                      aria-label={`Đổi tên file tải xuống, hiện tại là ${outputBase || preview.name}`}
                    >
                      <span className="truncate">{outputBase || preview.name}</span>
                      <Pencil className="w-3 h-3 opacity-40 group-hover:opacity-100 shrink-0" />
                    </button>
                  )}
                  <p className="text-xs text-ink-400 mt-1 font-mono animate-count-glow" key={preview.totalCount}>
                    {countFiles.toLocaleString('vi-VN')} file
                    {preview.totalSize ? ` · ~${formatBytes(countBytes)}` : ''}
                    {preview.unknownSizeCount
                      ? ` (${preview.unknownSizeCount} file Google Docs chưa rõ dung lượng)`
                      : ''}
                  </p>
                  {scannedAt && (
                    <p className="text-[11px] text-ink-500 mt-0.5 flex items-center gap-1">
                      <Clock className="w-3 h-3" /> Quét lúc {formatTimestamp(scannedAt)}
                    </p>
                  )}
                  {preview.exceedsLimit && (
                    <p className="text-[11px] text-kraft-400 mt-1.5 flex items-start gap-1 max-w-xs">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      Vượt giới hạn {formatBytes(preview.sizeLimit)} của server free — hãy chia nhỏ
                      thành các folder con rồi tải riêng từng phần.
                    </p>
                  )}
                </div>
                <button
                  onClick={handleDownload}
                  disabled={preview.exceedsLimit}
                  className="rounded-lg bg-stamp-500 hover:bg-stamp-400 active:scale-[0.96] active:rotate-1 disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2.5 text-sm font-semibold text-white transition-all duration-150 flex items-center gap-1.5 whitespace-nowrap shrink-0 shadow-lg shadow-stamp-500/20"
                >
                  <Download className="w-4 h-4" />
                  {preview.isFolder ? 'Tải .zip' : 'Tải xuống'}
                </button>
              </div>
            </div>
          )}

          {activeDownload && activeEntry && (
            <div className="mt-5 rounded-lg border border-kraft-500/25 bg-kraft-500/[0.05] p-4 animate-scale-in animate-border-glow">
              <div className="flex items-center gap-3">
                <div className="relative shrink-0">
                  <div className="w-10 h-10 rounded-full bg-kraft-500/15 flex items-center justify-center animate-pulse-ring">
                    <Loader2 className="w-5 h-5 text-kraft-400 animate-spin" />
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-white text-sm font-medium truncate">{activeEntry.name}</p>
                    {liveProgress?.status === 'done' && <PackedStamp />}
                  </div>
                  <p className="text-xs text-kraft-400/90 mt-0.5 transition-all duration-300 truncate font-mono">
                    {liveProgress?.status === 'queued'
                      ? liveProgress.queuePosition
                        ? `Đang xếp hàng — vị trí ${liveProgress.queuePosition}/${liveProgress.queueLength} (xíu thôi!)`
                        : 'Đang xếp hàng...'
                      : liveProgress?.status === 'done'
                        ? 'Zip xong xuôi, trình duyệt đang táp vào máy bạn...'
                        : liveProgress && liveProgress.status !== 'unknown'
                          ? liveProgress.currentFileName
                            ? `Đang nén: ${liveProgress.currentFileName}`
                            : 'Sắp xong rồi, đang gói nốt...'
                          : statusMsg}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-white font-mono text-lg tabular-nums">{formatElapsed(elapsed)}</p>
                  <p className="text-[10px] text-ink-500">thời gian đã trôi qua</p>
                </div>
              </div>

              {liveProgress?.status === 'queued' && (
                <div className="mt-3 flex items-center gap-2 text-[11px] text-kraft-400">
                  <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                  Đông vui ghê — cứ để đó, tới lượt là tự chạy, khỏi bấm lại cho mệt.
                </div>
              )}

              {liveProgress && liveProgress.status !== 'unknown' && liveProgress.status !== 'queued' && liveProgress.totalFiles > 0 && (
                <div className="mt-3">
                  <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full bg-kraft-400 transition-all duration-300 rounded-full"
                      style={{
                        width: `${Math.min(100, Math.round((liveProgress.completedFiles / liveProgress.totalFiles) * 100))}%`,
                      }}
                    />
                  </div>
                  <p className="text-[11px] text-ink-500 mt-1.5 flex items-center justify-between font-mono">
                    <span>
                      {liveProgress.completedFiles.toLocaleString('vi-VN')} / {liveProgress.totalFiles.toLocaleString('vi-VN')} file
                    </span>
                    {liveProgress.skipped.length > 0 && (
                      <span className="text-stamp-400">{liveProgress.skipped.length} file lỗi</span>
                    )}
                  </p>
                </div>
              )}

              {liveProgress && liveProgress.skipped.length > 0 && (
                <p className="text-[11px] text-stamp-400 mt-2 flex items-start gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  Một số file không tải được — chi tiết nằm trong file <code>_file_bi_loi.txt</code> đính kèm ngay trong zip.
                </p>
              )}

              <p className="text-[11px] text-ink-500 mt-3 flex items-center gap-1">
                <Clock className="w-3 h-3" /> Bắt đầu lúc {formatTimestamp(activeEntry.startedAt)}
              </p>
              <p className="text-xs text-ink-400 mt-2">
                Trình duyệt đang tải ở nền — kiểm tra thanh thông báo / mục Downloads. Với folder
                lớn có thể mất vài phút, cứ để chạy, không cần giữ tab này mở.
              </p>
              <button
                onClick={handleMarkDone}
                className="mt-3 w-full rounded-md border border-white/10 hover:border-kraft-500/30 hover:bg-white/5 text-ink-300 text-xs font-medium py-2 transition-colors"
              >
                Xong xuôi rồi — đóng bảng này lại
              </button>
            </div>
          )}
        </div>

        {history.length > 0 && (
          <div className="mt-4 animate-fade-in">
            <button
              onClick={() => setShowHistory((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-ink-400 hover:text-ink-200 transition-colors mx-auto"
            >
              <History className="w-3.5 h-3.5" />
              {showHistory ? 'Ẩn lịch sử tải' : `Xem lịch sử tải (${history.length})`}
            </button>
            {showHistory && (
              <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] divide-y divide-white/5 overflow-hidden animate-slide-up">
                {history.map((h) => (
                  <div key={h.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs">
                    <div className="min-w-0 flex items-center gap-2">
                      <FileArchive className="w-3.5 h-3.5 text-ink-500 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-ink-200 truncate max-w-[160px] sm:max-w-xs">{h.name}</p>
                        <p className="text-ink-500 font-mono">
                          {h.count} file{h.size ? ` · ${formatBytes(h.size)}` : ''} ·{' '}
                          {formatTimestamp(h.startedAt)}
                        </p>
                      </div>
                    </div>
                    <span
                      className={[
                        'shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium',
                        h.finishedAt
                          ? 'bg-seal-500/10 text-seal-400'
                          : 'bg-kraft-500/10 text-kraft-400',
                      ].join(' ')}
                    >
                      {h.finishedAt ? 'Hoàn tất' : 'Đang tải'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <p className="text-center text-xs text-ink-500 mt-6 max-w-lg mx-auto">
          Chỉ ăn được link chia sẻ kiểu{' '}
          <span className="text-ink-300">"Anyone with the link"</span> thôi nha — Google
          Docs/Sheets/Slides thì auto đổi đuôi qua .docx/.xlsx/.pptx cho bạn luôn.
        </p>
      </div>
    </main>
  );
}
