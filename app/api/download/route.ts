import { NextRequest } from 'next/server';
import archiver from 'archiver';
import { Readable, Transform } from 'stream';
import {
  parseDriveUrl,
  resolveDriveTarget,
  listFolderRecursive,
  buildDownloadRequest,
  finalExtName,
  sanitize,
  contentDisposition,
  fetchWithRetry,
  sumKnownSizes,
  maxTotalDownloadBytes,
  maxFilesPerDownload,
  uniquePaths,
  DriveLimitError,
} from '@/lib/drive';
import { acquireSlot, release, isQueueFull, maxQueue } from '@/lib/download-lock';
import {
  createProgress,
  updateProgress,
  addSkipped,
  finishProgress,
  touchProgress,
  isValidToken,
} from '@/lib/progress-store';
import { listingLimiter, LISTING_BUSY_MESSAGE } from '@/lib/listing-limit';
import { positiveIntEnv } from '@/lib/limiter';
import { errorMessage } from '@/lib/errors';

export const runtime = 'nodejs';
// Vercel Hobby sẽ tự giới hạn thực tế ở 60s dù khai báo cao hơn ở đây.
// Nếu deploy trên Render/Railway/VPS (server chạy liên tục, không phải serverless
// theo giây), giá trị này không có ý nghĩa và không giới hạn thời gian chạy thật.
export const maxDuration = 300;

type DownloadFile = { id: string; path: string; mimeType: string; resourceKey?: string; size?: string };

/** Quá ngần này KHÔNG có tiến triển nào (không byte nào ra tới client, không file nào xong)
 * thì dừng lượt tải để trả slot (`DOWNLOAD_IDLE_TIMEOUT_SECONDS`, mặc định 600 = 10 phút).
 * Bắt cả hai kiểu treo: Google ngừng gửi dữ liệu, và client mở kết nối nhưng không đọc nữa
 * (hoặc đang tạm dừng tải rất lâu) — nếu không, mỗi lượt như vậy giữ 1/3 slot mãi mãi. */
const idleTimeoutMs = () => positiveIntEnv(process.env.DOWNLOAD_IDLE_TIMEOUT_SECONDS, 600) * 1000;

const queueFullMessage = () =>
  `Server đang rất đông (đã có ${maxQueue()} lượt đang chờ). Vui lòng thử lại sau ít phút.`;

/** Trả về 1 file .zip DUY NHẤT, nén streaming trên server rồi truyền thẳng cho
 * trình duyệt như 1 lượt tải file bình thường (native download). Vì đây là
 * download thật (không phải fetch+Blob trong JS), trình duyệt ghi thẳng ra ổ
 * đĩa qua tầng mạng của hệ điều hành — không tốn RAM của trang web, hoạt động
 * giống nhau trên desktop lẫn mobile, không cần chia nhỏ thành nhiều phần. */
export async function GET(req: NextRequest) {
  const apiKey = process.env.GOOGLE_API_KEY;
  const driveUrl = req.nextUrl.searchParams.get('url');
  const customName = req.nextUrl.searchParams.get('name');
  const rawToken = req.nextUrl.searchParams.get('token'); // dùng để báo tiến độ + vị trí hàng đợi qua /api/progress (tuỳ chọn)
  const token = rawToken && isValidToken(rawToken) ? rawToken : null;

  // Tạo phiên tiến độ NGAY (trạng thái "đang quét") thay vì đợi quét xong rồi mới tạo như trước:
  // tab đang nghe SSE thấy ngay trạng thái thật (không phải chuỗi "unknown" kéo dài suốt thời gian
  // quét folder lớn) và mọi lỗi SỚM bên dưới có chỗ để báo về.
  if (token) createProgress(token, 0, 'listing');

  // Lỗi SỚM (trước khi bắt đầu tải): trình duyệt đang ĐIỀU HƯỚNG thẳng tới URL này, nên trả
  // text lỗi bình thường sẽ THAY CẢ TRANG web bằng dòng chữ thô đó (mất giao diện + tiến độ).
  // Có `token` nghĩa là UI đang nghe SSE → báo lỗi qua SSE và trả 204 (trình duyệt giữ nguyên
  // trang, không điều hướng). Gọi API trực tiếp (không token) thì vẫn trả đúng status + text.
  const fail = (status: number, message: string, headers?: Record<string, string>) => {
    if (token) {
      finishProgress(token, 'error', message);
      return new Response(null, { status: 204 });
    }
    return new Response(message, { status, headers });
  };

  if (!apiKey) return fail(500, 'Server chưa cấu hình GOOGLE_API_KEY.');
  if (!driveUrl) return fail(400, 'Thiếu tham số url.');

  // Hàng đợi đã đầy → từ chối ngay, đừng tốn công quét folder rồi mới báo lỗi.
  if (isQueueFull()) return fail(503, queueFullMessage(), { 'Retry-After': '30' });

  // Quét diễn ra TRƯỚC hàng đợi nên cần trần đồng thời riêng (xem lib/listing-limit.ts).
  const leaveListing = listingLimiter.tryEnter();
  if (!leaveListing) return fail(503, LISTING_BUSY_MESSAGE, { 'Retry-After': '5' });

  let files: DownloadFile[];
  let zipName = 'drive-download';

  // Liệt kê file & kiểm tra giới hạn size TRƯỚC KHI xếp hàng — nếu link sai hoặc
  // folder vượt giới hạn, báo lỗi ngay, không bắt người dùng chờ hàng đợi vô ích.
  try {
    // `signal`: client đóng tab thì dừng duyệt cây thư mục ngay, không gọi API tiếp.
    const target = await resolveDriveTarget(parseDriveUrl(driveUrl), apiKey, req.signal);

    if (target.type === 'file') {
      const { meta } = target;
      files = [
        {
          id: meta.id,
          path: finalExtName(sanitize(meta.name), meta.mimeType),
          mimeType: meta.mimeType,
          resourceKey: target.resourceKey,
          size: meta.size,
        },
      ];
      zipName = sanitize(meta.name.replace(/\.[^./]+$/, '')) || 'file';
    } else {
      // listFolderRecursive tự đọc và gắn đúng resourceKey CỦA TỪNG FILE/SUBFOLDER
      // (field output-only của Drive API v3) — không có file nào ở đây dùng lại
      // resourceKey của folder gốc trừ khi bản thân nó thực sự mang đúng giá trị đó.
      const raw = await listFolderRecursive(target.id, apiKey, '', target.resourceKey, {
        signal: req.signal,
        maxFiles: maxFilesPerDownload(),
      });
      files = raw.map((f) => ({
        id: f.id,
        path: finalExtName(f.path, f.mimeType),
        mimeType: f.mimeType,
        resourceKey: f.resourceKey,
        size: f.size,
      }));
      zipName = sanitize(target.meta?.name || 'GoogleDrive_Folder');
    }
  } catch (err: unknown) {
    if (err instanceof DriveLimitError) return fail(413, err.message);
    return fail(400, errorMessage(err, 'Không đọc được link Drive.'));
  } finally {
    leaveListing();
  }

  // Cho phép người dùng tự đặt tên file zip đầu ra (tính năng "đổi tên" trên UI)
  if (customName && customName.trim()) {
    zipName = sanitize(customName.trim());
  }

  if (files.length === 0) {
    return fail(404, 'Không tìm thấy file nào (folder rỗng hoặc không public).');
  }

  // Chặn sớm nếu tổng dung lượng (đã biết) vượt giới hạn cấu hình — mặc định KHÔNG
  // giới hạn (sizeLimit = null), chỉ áp dụng nếu bạn tự set MAX_TOTAL_DOWNLOAD_BYTES.
  const totalKnownSize = sumKnownSizes(files);
  const sizeLimit = maxTotalDownloadBytes();
  if (sizeLimit != null && totalKnownSize > sizeLimit) {
    const limitGb = (sizeLimit / 1024 / 1024 / 1024).toFixed(1);
    const actualGb = (totalKnownSize / 1024 / 1024 / 1024).toFixed(1);
    return fail(
      413,
      `Folder này ~${actualGb}GB, vượt giới hạn ${limitGb}GB đã cấu hình. Hãy chia nhỏ thành các folder con rồi tải riêng từng phần.`
    );
  }

  // Tên entry trong zip PHẢI duy nhất: Drive cho phép nhiều file cùng tên trong 1 folder (và
  // sanitize/finalExtName còn tạo thêm va chạm). Zip có entry trùng tên thì giải nén bị ghi
  // đè hoặc hỏi — mất dữ liệu âm thầm.
  files = uniquePaths(files);

  if (token) updateProgress(token, { totalFiles: files.length, status: 'queued' });

  // Giữa lúc quét và giờ hàng đợi có thể đã đầy thêm.
  if (isQueueFull()) return fail(503, queueFullMessage(), { 'Retry-After': '30' });

  // XẾP HÀNG: chờ tới lượt được xử lý thật sự (xem lib/download-lock.ts). Nếu
  // server đang rảnh, acquireSlot() trả về gần như ngay lập tức; nếu đông, request
  // này (và trình duyệt đang chờ tải) sẽ tự động đợi tới khi có slot trống, đồng
  // thời `token` (nếu có) được cập nhật vị trí hàng đợi để UI hiển thị real-time.
  const outcome = await acquireSlot(token, req.signal ?? undefined);
  if (outcome === 'aborted') {
    if (token) finishProgress(token, 'error', 'Đã huỷ khi đang xếp hàng.');
    return new Response('Đã huỷ.', { status: 499 });
  }
  if (token) updateProgress(token, { status: 'running', queuePosition: undefined, queueLength: undefined });

  // Từ đây trở đi ĐÃ chiếm 1 slot thật sự — MỌI đường thoát (kể cả lỗi) đều phải
  // release() nó, nếu không người xếp hàng phía sau sẽ bị kẹt vô thời hạn.
  let released = false;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  const releaseOnce = () => {
    if (watchdog) clearInterval(watchdog);
    if (!released) {
      released = true;
      release();
    }
  };

  // Mọi byte gửi cho client đều đi qua đây → đây cũng là "mạch đập" của lượt tải (xem watchdog).
  // Nhờ backpressure, `transform` chỉ chạy khi phía client thật sự đang đọc.
  let lastActivity = Date.now();
  const passthrough = new Transform({
    transform(chunk, _encoding, callback) {
      lastActivity = Date.now();
      callback(null, chunk);
    },
  });
  // level: 0 = "store" (không nén) — giảm tải CPU tối đa cho server free,
  // đổi lại file zip không nhỏ hơn tổng dung lượng gốc (đa số ảnh/video/pdf vốn
  // đã nén sẵn nên nén thêm cũng không lợi bao nhiêu).
  const archive = archiver('zip', { zlib: { level: 0 } });

  archive.on('warning', (err) => console.warn('archiver warning:', err));
  archive.on('error', (err) => passthrough.destroy(err));
  archive.pipe(passthrough);

  let aborted = false; // client chủ động huỷ/đóng kết nối
  let fatalError: Error | null = null; // lỗi KHÔNG cứu được (xem fatal() bên dưới)
  let wakeUp: ((e: Error) => void) | null = null; // đánh thức vòng lặp đang chờ 1 entry ghi xong

  /** Lỗi nghiêm trọng giữa chừng: dừng TOÀN BỘ lượt tải và cắt ngang response.
   *
   * Khi 1 nguồn bị đứt SAU khi đã được ghi (một phần) vào zip, không thể "bỏ qua file đó" như
   * lỗi trước khi ghi: entry đã dở dang, và archiver KHÔNG báo lỗi ra (nó nối nguồn qua
   * `pipe()`, mà pipe không chuyển tiếp lỗi) nên entry không bao giờ kết thúc, hàng đợi của
   * archiver kẹt vĩnh viễn, vòng lặp bên dưới treo mãi và GIỮ SLOT. Thà thất bại ngay và rõ
   * ràng: response bị cắt đột ngột nên trình duyệt báo "tải thất bại" (không phải một file
   * zip trông như đã xong mà thiếu dữ liệu), slot được trả cho người đang xếp hàng. */
  const fatal = (err: unknown) => {
    if (aborted || fatalError) return;
    fatalError = err instanceof Error ? err : new Error(errorMessage(err, 'Lỗi không xác định.'));
    try {
      archive.abort();
    } catch {
      /* đã dừng rồi */
    }
    passthrough.destroy(fatalError);
    if (token) finishProgress(token, 'error', fatalError.message);
    wakeUp?.(fatalError);
    releaseOnce();
  };

  // Nếu client huỷ kết nối giữa chừng (đóng tab, mất mạng), dừng ngay việc kéo
  // dữ liệu từ Google thay vì tiếp tục chạy ngầm lãng phí tài nguyên server.
  const onClientAbort = () => {
    if (aborted) return;
    aborted = true;
    try {
      archive.abort();
    } catch {
      /* đã dừng rồi */
    }
    passthrough.destroy();
    wakeUp?.(new DOMException('Đã huỷ theo yêu cầu.', 'AbortError')); // không để vòng lặp treo chờ entry mãi
    if (token) finishProgress(token, 'error', 'Kết nối bị huỷ giữa chừng.');
    releaseOnce();
  };
  // Signal có thể ĐÃ abort (client ngắt ngay sau khi được cấp slot): lúc đó addEventListener sẽ
  // không bao giờ nổ, nên phải kiểm tra trước.
  if (req.signal?.aborted) onClientAbort();
  else req.signal?.addEventListener('abort', onClientAbort, { once: true });
  if (aborted) return new Response('Đã huỷ.', { status: 499 });

  // Kiểm tra mỗi ≤5s (nhanh hơn nếu timeout cấu hình rất ngắn) — rẻ: chỉ so sánh 2 con số.
  const watchdogTickMs = Math.max(250, Math.min(5000, Math.floor(idleTimeoutMs() / 4)));
  watchdog = setInterval(() => {
    if (Date.now() - lastActivity > idleTimeoutMs()) {
      fatal(new Error('Quá lâu không có dữ liệu (Google hoặc trình duyệt ngừng phản hồi) — đã dừng lượt tải này. Hãy thử tải lại.'));
    } else if (token) {
      touchProgress(token); // đang truyền 1 file rất lớn (chưa file nào xong) vẫn là "còn sống"
    }
  }, watchdogTickMs);

  // Mở trước tối đa CONCURRENCY kết nối tới Google Drive cùng lúc để giấu bớt độ trễ
  // mạng (network latency) — nhưng vẫn chỉ GHI vào file zip TỪNG FILE MỘT theo đúng
  // thứ tự, vì bản thân định dạng zip + archiver chỉ ghi tuần tự được. Mở trước kết
  // nối (chưa đọc dữ liệu) gần như không tốn thêm RAM, vì dữ liệu chưa đọc vẫn nằm ở
  // buffer mạng (TCP) chứ chưa được kéo vào bộ nhớ Node — khác hẳn lỗi cũ (đọc + ghi
  // nhiều file cùng lúc). Đây là điểm mấu chốt để vừa nhanh vừa không tràn RAM.
  const CONCURRENCY = 3;
  const RETRY_ATTEMPTS = 3;

  /** Append 1 entry rồi chờ archiver ghi XONG hẳn. Luôn gỡ listener khi xong — trước đây mỗi
   * file thêm 1 listener 'error' không bao giờ gỡ (cảnh báo MaxListenersExceededWarning từ file
   * thứ 10 và rò rỉ nhỏ theo số file). Bị đánh thức (reject) ngay khi huỷ/lỗi nghiêm trọng. */
  const appendAndWait = (name: string, content: string | Buffer | Readable) =>
    new Promise<void>((resolve, reject) => {
      const source = content instanceof Readable ? content : null;
      const cleanup = () => {
        archive.off('entry', onEntry);
        archive.off('error', onError);
        source?.off('error', onError);
        if (wakeUp === onError) wakeUp = null;
      };
      const onEntry = () => {
        cleanup();
        resolve();
      };
      const onError = (e: Error) => {
        cleanup();
        reject(e);
      };
      wakeUp = onError;
      archive.on('entry', onEntry); // fires khi archiver ghi xong entry vừa append
      archive.on('error', onError);
      source?.on('error', onError);
      archive.append(content, { name });
    });

  (async () => {
    let nextIndex = 0;
    let processedCount = 0;
    const skipped: { name: string; reason: string }[] = [];
    // Loại Google không export được (Forms, Sites, shortcut...): bỏ qua có chủ đích, KHÔNG phải lỗi
    // (không tính vào bộ đếm lỗi trên UI) nhưng vẫn phải ghi vào manifest — nếu không, người tải
    // tưởng zip đã đủ trong khi shortcut/biểu mẫu âm thầm biến mất.
    const unsupported: string[] = [];

    const startFetch = async (file: DownloadFile) => {
      try {
        const request = buildDownloadRequest(file.id, file.mimeType, apiKey, file.resourceKey);
        if (!request) return { file, res: null as Response | null, error: null as string | null };
        const res = await fetchWithRetry(
          request.url.toString(),
          request.headers ? { headers: request.headers } : undefined,
          RETRY_ATTEMPTS,
          req.signal ?? undefined
        );
        return { file, res: res as Response | null, error: null as string | null };
      } catch (e: unknown) {
        return { file, res: null as Response | null, error: errorMessage(e, 'Lỗi mạng.') };
      }
    };

    const inFlight: ReturnType<typeof startFetch>[] = [];
    try {
      for (; nextIndex < Math.min(CONCURRENCY, files.length); nextIndex++) {
        inFlight.push(startFetch(files[nextIndex]));
      }

      while (inFlight.length > 0) {
        if (aborted || fatalError) break;
        const { file, res, error } = await inFlight.shift()!;
        lastActivity = Date.now(); // có tiến triển (dù file này sắp bị bỏ qua)
        if (aborted || fatalError) {
          void res?.body?.cancel().catch(() => {});
          break;
        }

        // Mồi thêm 1 fetch mới cho file kế tiếp để giữ nguyên cửa sổ concurrency
        if (nextIndex < files.length) {
          inFlight.push(startFetch(files[nextIndex]));
          nextIndex++;
        }

        if (token) updateProgress(token, { currentFileName: file.path });

        if (error) {
          console.warn(`Bỏ qua "${file.path}" sau ${RETRY_ATTEMPTS} lần thử — ${error}`);
          skipped.push({ name: file.path, reason: error });
          processedCount += 1;
          if (token) {
            addSkipped(token, file.path, error);
            updateProgress(token, { completedFiles: processedCount });
          }
          continue;
        }
        if (!res) {
          unsupported.push(file.path);
          processedCount += 1;
          if (token) updateProgress(token, { completedFiles: processedCount });
          continue; // loại native Google không export được (Forms, Sites...)
        }
        if (!res.ok || !res.body) {
          void res.body?.cancel().catch(() => {}); // không để body chưa đọc giữ socket tới khi GC
          const reason = `HTTP ${res.status}`;
          console.warn(`Bỏ qua "${file.path}" — ${reason}`);
          skipped.push({ name: file.path, reason });
          processedCount += 1;
          if (token) {
            addSkipped(token, file.path, reason);
            updateProgress(token, { completedFiles: processedCount });
          }
          continue;
        }

        try {
          // res.body được TypeScript suy ra kiểu ReadableStream của DOM lib (vì dự án
          // include "dom" trong tsconfig để Next.js dùng được ở client) — nhưng
          // Readable.fromWeb() của Node lại yêu cầu đúng kiểu ReadableStream của
          // node:stream/web. Hai kiểu này CẤU TRÚC giống hệt nhau (đều đúng chuẩn Web
          // Streams) nhưng TypeScript coi là 2 type riêng biệt vì khai báo từ 2 nguồn
          // lib khác nhau — ép kiểu qua `unknown` rồi sang đúng type Node cần, thay vì
          // `any` (vốn tắt luôn toàn bộ type-check thay vì chỉ giải quyết đúng chỗ
          // xung đột giữa 2 khai báo ReadableStream này).
          const nodeStream = Readable.fromWeb(
            res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>
          );
          // Luôn có ít nhất 1 listener 'error' (lỗi được xử lý qua appendAndWait) để một lỗi
          // muộn sau khi entry đã xong không bao giờ thành "uncaught exception".
          nodeStream.on('error', () => {});

          // Đợi archiver ghi XONG hẳn entry này ra output rồi mới lấy kết quả file kế
          // tiếp từ hàng đợi — đảm bảo tại một thời điểm chỉ có đúng 1 file đang được
          // ĐỌC + GHI thật sự, dù có tối đa CONCURRENCY kết nối đang "chờ sẵn" phía sau.
          await appendAndWait(file.path, nodeStream);
          lastActivity = Date.now();
          processedCount += 1;
          if (token) updateProgress(token, { completedFiles: processedCount });
        } catch (e: unknown) {
          // Mọi lỗi ở đây xảy ra SAU khi nguồn đã được nối vào zip → entry dở dang, không thể
          // bỏ qua riêng file này (xem fatal()).
          if (aborted || fatalError) break;
          console.warn(`Dừng lượt tải: lỗi khi ghi "${file.path}" vào zip:`, e);
          fatal(
            new Error(
              `Mất kết nối khi đang tải "${file.path}" (${errorMessage(e, 'lỗi không xác định')}). Hãy thử tải lại.`
            )
          );
          break;
        }
      }

      if (aborted || fatalError) return;

      // Nếu có file bị bỏ qua, kèm 1 file text liệt kê trong chính zip — để người
      // tải BIẾT RÕ file nào thiếu và vì sao, thay vì phát hiện thiếu sót âm thầm.
      if (skipped.length > 0 || unsupported.length > 0) {
        const lines: string[] = [];
        if (skipped.length > 0) {
          lines.push(
            `${skipped.length} file KHÔNG tải được và bị bỏ qua khỏi zip này:`,
            '',
            ...skipped.map((s) => `- ${s.name}\n  Lý do: ${s.reason}`),
            '',
            'Gợi ý: thử tải lại (các lỗi mạng/429 tạm thời thường tự hết sau vài phút),',
            'hoặc kiểm tra quyền chia sẻ của từng file cụ thể trên Google Drive.'
          );
        }
        if (unsupported.length > 0) {
          if (lines.length > 0) lines.push('');
          lines.push(
            `${unsupported.length} mục thuộc loại Google không hỗ trợ tải/export (Google Forms, Sites, shortcut...) nên KHÔNG có trong zip này:`,
            '',
            ...unsupported.map((n) => `- ${n}`)
          );
        }
        const manifest = lines.join('\n');
        await appendAndWait('_file_bi_loi.txt', manifest).catch((e) =>
          console.warn('Không ghi được manifest file lỗi:', e)
        );
        if (aborted || fatalError) return;
      }

      // Không await: finalize() chỉ báo hiệu "hết entry". Promise của nó reject khi archiver
      // lỗi — lỗi đó đã được xử lý ở archive.on('error'); .catch ở đây chỉ để không thành
      // unhandled rejection.
      archive.finalize().catch(() => {});
      if (token) {
        updateProgress(token, { completedFiles: files.length, currentFileName: null });
        finishProgress(token, 'done');
      }
    } finally {
      // Dọn các kết nối đã mở trước mà không dùng tới (huỷ / lỗi nghiêm trọng giữa chừng).
      for (const pending of inFlight) {
        void pending.then(({ res }) => res?.body?.cancel()).catch(() => {});
      }
    }
  })().catch((e: unknown) => fatal(e));

  // Chỉ giải phóng slot concurrency khi luồng dữ liệu ĐÃ thật sự đẩy hết (hoặc lỗi/
  // đóng giữa chừng) tới client — không giải phóng ngay khi archive.finalize() được
  // gọi, vì tại thời điểm đó dữ liệu cuối vẫn còn đang được flush qua mạng.
  passthrough.on('close', releaseOnce);
  passthrough.on('error', releaseOnce);

  const webStream = Readable.toWeb(passthrough) as unknown as ReadableStream;

  return new Response(webStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(`${zipName}.zip`),
      'Cache-Control': 'no-store',
    },
  });
}
