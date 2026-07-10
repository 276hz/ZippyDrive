import { NextRequest } from 'next/server';
import archiver from 'archiver';
import { PassThrough, Readable } from 'stream';
import {
  parseDriveUrl,
  listFolderRecursive,
  getFileMeta,
  buildDownloadRequest,
  finalExtName,
  sanitize,
  contentDisposition,
  fetchWithRetry,
  sumKnownSizes,
  maxTotalDownloadBytes,
} from '@/lib/drive';
import { acquireSlot, release } from '@/lib/download-lock';
import { createProgress, updateProgress, addSkipped, finishProgress } from '@/lib/progress-store';

export const runtime = 'nodejs';
// Vercel Hobby sẽ tự giới hạn thực tế ở 60s dù khai báo cao hơn ở đây.
// Nếu deploy trên Render/Railway/VPS (server chạy liên tục, không phải serverless
// theo giây), giá trị này không có ý nghĩa và không giới hạn thời gian chạy thật.
export const maxDuration = 300;

/** Trả về 1 file .zip DUY NHẤT, nén streaming trên server rồi truyền thẳng cho
 * trình duyệt như 1 lượt tải file bình thường (native download). Vì đây là
 * download thật (không phải fetch+Blob trong JS), trình duyệt ghi thẳng ra ổ
 * đĩa qua tầng mạng của hệ điều hành — không tốn RAM của trang web, hoạt động
 * giống nhau trên desktop lẫn mobile, không cần chia nhỏ thành nhiều phần. */
export async function GET(req: NextRequest) {
  const apiKey = process.env.GOOGLE_API_KEY;
  const driveUrl = req.nextUrl.searchParams.get('url');
  const customName = req.nextUrl.searchParams.get('name');
  const token = req.nextUrl.searchParams.get('token'); // dùng để báo tiến độ + vị trí hàng đợi qua /api/progress (tuỳ chọn)

  if (!apiKey) return new Response('Server chưa cấu hình GOOGLE_API_KEY.', { status: 500 });
  if (!driveUrl) return new Response('Thiếu tham số url.', { status: 400 });

  let files: { id: string; path: string; mimeType: string; resourceKey?: string; size?: string }[];
  let zipName = 'drive-download';

  // Liệt kê file & kiểm tra giới hạn size TRƯỚC KHI xếp hàng — nếu link sai hoặc
  // folder vượt giới hạn, báo lỗi ngay, không bắt người dùng chờ hàng đợi vô ích.
  try {
    const { type, id, resourceKey } = parseDriveUrl(driveUrl);

    if (type === 'file') {
      const meta = await getFileMeta(id, apiKey, resourceKey);
      files = [
        {
          id: meta.id,
          path: finalExtName(sanitize(meta.name), meta.mimeType),
          mimeType: meta.mimeType,
          resourceKey,
          size: meta.size,
        },
      ];
      zipName = sanitize(meta.name.replace(/\.[^./]+$/, '')) || 'file';
    } else {
      const meta = await getFileMeta(id, apiKey, resourceKey).catch(() => ({ name: 'GoogleDrive_Folder' } as any));
      const raw = await listFolderRecursive(id, apiKey, '', resourceKey);
      // resourceKey chỉ áp dụng cho ID gốc được share trực tiếp (folder cha), nên chỉ
      // gắn vào các file nằm ngay trong folder gốc đó — nhưng để đơn giản và an toàn,
      // Google Drive API chấp nhận header này cho cả file con nên truyền chung không sao.
      files = raw.map((f) => ({
        id: f.id,
        path: finalExtName(f.path, f.mimeType),
        mimeType: f.mimeType,
        resourceKey,
        size: f.size,
      }));
      zipName = sanitize(meta.name || 'GoogleDrive_Folder');
    }
  } catch (err: any) {
    return new Response(err?.message ?? 'Không đọc được link Drive.', { status: 400 });
  }

  // Cho phép người dùng tự đặt tên file zip đầu ra (tính năng "đổi tên" trên UI)
  if (customName && customName.trim()) {
    zipName = sanitize(customName.trim());
  }

  if (files.length === 0) {
    return new Response('Không tìm thấy file nào (folder rỗng hoặc không public).', { status: 404 });
  }

  // Chặn sớm nếu tổng dung lượng (đã biết) vượt giới hạn cấu hình — mặc định KHÔNG
  // giới hạn (sizeLimit = null), chỉ áp dụng nếu bạn tự set MAX_TOTAL_DOWNLOAD_BYTES.
  const totalKnownSize = sumKnownSizes(files);
  const sizeLimit = maxTotalDownloadBytes();
  if (sizeLimit != null && totalKnownSize > sizeLimit) {
    const limitGb = (sizeLimit / 1024 / 1024 / 1024).toFixed(1);
    const actualGb = (totalKnownSize / 1024 / 1024 / 1024).toFixed(1);
    return new Response(
      `Folder này ~${actualGb}GB, vượt giới hạn ${limitGb}GB đã cấu hình. Hãy chia nhỏ thành các folder con rồi tải riêng từng phần.`,
      { status: 413 }
    );
  }

  if (token) createProgress(token, files.length, 'queued');

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
  const releaseOnce = () => {
    if (!released) {
      released = true;
      release();
    }
  };

  const passthrough = new PassThrough();
  // level: 0 = "store" (không nén) — giảm tải CPU tối đa cho server free,
  // đổi lại file zip không nhỏ hơn tổng dung lượng gốc (đa số ảnh/video/pdf vốn
  // đã nén sẵn nên nén thêm cũng không lợi bao nhiêu).
  const archive = archiver('zip', { zlib: { level: 0 } });

  archive.on('warning', (err) => console.warn('archiver warning:', err));
  archive.on('error', (err) => passthrough.destroy(err));
  archive.pipe(passthrough);

  // Nếu client huỷ kết nối giữa chừng (đóng tab, mất mạng), dừng ngay việc kéo
  // dữ liệu từ Google thay vì tiếp tục chạy ngầm lãng phí tài nguyên server.
  let aborted = false;
  req.signal?.addEventListener('abort', () => {
    aborted = true;
    archive.abort();
    passthrough.destroy();
    if (token) finishProgress(token, 'error', 'Kết nối bị huỷ giữa chừng.');
    releaseOnce();
  });

  // Mở trước tối đa CONCURRENCY kết nối tới Google Drive cùng lúc để giấu bớt độ trễ
  // mạng (network latency) — nhưng vẫn chỉ GHI vào file zip TỪNG FILE MỘT theo đúng
  // thứ tự, vì bản thân định dạng zip + archiver chỉ ghi tuần tự được. Mở trước kết
  // nối (chưa đọc dữ liệu) gần như không tốn thêm RAM, vì dữ liệu chưa đọc vẫn nằm ở
  // buffer mạng (TCP) chứ chưa được kéo vào bộ nhớ Node — khác hẳn lỗi cũ (đọc + ghi
  // nhiều file cùng lúc). Đây là điểm mấu chốt để vừa nhanh vừa không tràn RAM.
  const CONCURRENCY = 3;
  const RETRY_ATTEMPTS = 3;

  const appendToArchive = (name: string, content: string | Buffer) =>
    new Promise<void>((resolve, reject) => {
      archive.once('error', reject);
      archive.append(content, { name });
      archive.once('entry', resolve);
    });

  (async () => {
    let nextIndex = 0;
    let processedCount = 0;
    const skipped: { name: string; reason: string }[] = [];

    const startFetch = (file: (typeof files)[number]) => {
      const request = buildDownloadRequest(file.id, file.mimeType, apiKey, file.resourceKey);
      if (!request) return Promise.resolve({ file, res: null as Response | null, error: null as string | null });
      return fetchWithRetry(request.url.toString(), request.headers ? { headers: request.headers } : undefined, RETRY_ATTEMPTS)
        .then((res) => ({ file, res, error: null as string | null }))
        .catch((e) => ({ file, res: null as Response | null, error: e?.message ?? 'Lỗi mạng.' }));
    };

    const inFlight: ReturnType<typeof startFetch>[] = [];
    for (; nextIndex < Math.min(CONCURRENCY, files.length); nextIndex++) {
      inFlight.push(startFetch(files[nextIndex]));
    }

    while (inFlight.length > 0) {
      if (aborted) break;
      const { file, res, error } = await inFlight.shift()!;

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
        processedCount += 1;
        if (token) updateProgress(token, { completedFiles: processedCount });
        continue; // loại native Google không export được (Forms, Sites...)
      }
      if (!res.ok || !res.body) {
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
        const nodeStream = Readable.fromWeb(res.body as any);

        // Đợi archiver ghi XONG hẳn entry này ra output rồi mới lấy kết quả file kế
        // tiếp từ hàng đợi — đảm bảo tại một thời điểm chỉ có đúng 1 file đang được
        // ĐỌC + GHI thật sự, dù có tối đa CONCURRENCY kết nối đang "chờ sẵn" phía sau.
        await new Promise<void>((resolve, reject) => {
          nodeStream.once('error', reject);
          archive.once('error', reject);
          archive.append(nodeStream, { name: file.path });
          archive.once('entry', resolve); // fires khi archiver ghi xong entry vừa append
        });
        processedCount += 1;
        if (token) updateProgress(token, { completedFiles: processedCount });
      } catch (e: any) {
        const reason = e?.message ?? 'Lỗi khi ghi vào zip.';
        console.warn(`Bỏ qua "${file.path}" do lỗi ghi vào zip:`, e);
        skipped.push({ name: file.path, reason });
        processedCount += 1;
        if (token) {
          addSkipped(token, file.path, reason);
          updateProgress(token, { completedFiles: processedCount });
        }
      }
    }

    // Nếu có file bị bỏ qua, kèm 1 file text liệt kê trong chính zip — để người
    // tải BIẾT RÕ file nào thiếu và vì sao, thay vì phát hiện thiếu sót âm thầm.
    if (!aborted && skipped.length > 0) {
      const manifest = [
        `${skipped.length} file KHÔNG tải được và bị bỏ qua khỏi zip này:`,
        '',
        ...skipped.map((s) => `- ${s.name}\n  Lý do: ${s.reason}`),
        '',
        'Gợi ý: thử tải lại (các lỗi mạng/429 tạm thời thường tự hết sau vài phút),',
        'hoặc kiểm tra quyền chia sẻ của từng file cụ thể trên Google Drive.',
      ].join('\n');
      await appendToArchive('_file_bi_loi.txt', manifest).catch((e) =>
        console.warn('Không ghi được manifest file lỗi:', e)
      );
    }

    if (!aborted) {
      archive.finalize();
      if (token) {
        updateProgress(token, { completedFiles: files.length, currentFileName: null });
        finishProgress(token, 'done');
      }
    }
  })().catch((e) => {
    passthrough.destroy(e);
    if (token) finishProgress(token, 'error', e?.message ?? 'Lỗi không xác định.');
    releaseOnce();
  });

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
