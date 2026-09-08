/**
 * Architecture B — ráp file thành 1 zip NGAY TRONG BROWSER, stream thẳng ra đĩa
 * qua File System Access API. Không giữ cả zip trong RAM cùng lúc — mỗi file
 * được fetch rồi ghi thẳng vào writable stream, giải phóng ngay sau đó.
 *
 * CHỈ chạy được khi trình duyệt hỗ trợ showSaveFilePicker — theo nghiên cứu đã
 * làm, đó là Chrome/Edge/Opera desktop. Firefox/Safari/mobile KHÔNG hỗ trợ, đây
 * là lập trường chính sách của các trình duyệt đó (Mozilla công khai từ chối
 * triển khai), không phải thiếu sót có thể tự vá. Trình duyệt không hỗ trợ →
 * page.tsx tự fallback sang downloadFolderDirect() (Architecture C, lib/client-drive.ts).
 *
 * Dùng @zip.js/zip.js — API dưới đây xác nhận trực tiếp từ
 * node_modules/@zip.js/zip.js/index.d.ts lúc viết (bản 2.8.53), không phải nhớ lại:
 *   - `new ZipWriter(writableStream, options)` nhận thẳng WritableStream —
 *     FileSystemWritableFileStream tương thích trực tiếp, không cần adapter.
 *   - `zipWriter.add(path, readableStream)` nhận thẳng ReadableStream —
 *     response.body từ fetch() tương thích trực tiếp.
 *   - filename cho phép "/" thật, lưu nguyên trạng — KHÁC Architecture C (nơi
 *     <a download> buộc phải flatten "/" thành "_"). Nghĩa là Architecture B giữ
 *     được cấu trúc thư mục con thật bên trong file zip, C thì không.
 *   - zip64 tự bật khi cần (>4GB/entry hoặc size không rõ trước) — khớp chủ
 *     trương "không giới hạn nhân tạo", không dính trần 4GB cổ điển của zip.
 *   - useWebWorkers mặc định true — nén/CRC32 chạy ở Worker riêng, không chặn
 *     UI thread, không cần tự viết Web Worker wrapper.
 */

import { ZipWriter } from '@zip.js/zip.js';
import {
  buildMediaUrl,
  fetchWithRetry,
  type DirectDownloadFile,
  type DirectDownloadProgress,
} from './client-drive';

/** Gọi trong useEffect ở client component, KHÔNG gọi trực tiếp lúc render —
 * window.showSaveFilePicker không tồn tại lúc SSR, gọi thẳng lúc render sẽ lệch
 * giữa HTML server render và lần render đầu của client (hydration mismatch). */
export function fsaSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as any).showSaveFilePicker === 'function';
}

export async function downloadFolderAsZip(
  files: DirectDownloadFile[],
  resourceKey: string | null | undefined,
  suggestedName: string,
  onProgress: (p: DirectDownloadProgress) => void,
  signal?: AbortSignal
): Promise<{ ok: true } | { ok: false; error: string; cancelled?: boolean }> {
  if (!fsaSupported()) {
    return {
      ok: false,
      error: 'Trình duyệt này không hỗ trợ lưu trực tiếp ra đĩa (File System Access API).',
    };
  }

  const name = suggestedName.toLowerCase().endsWith('.zip') ? suggestedName : `${suggestedName}.zip`;
  let handle: any;
  try {
    handle = await (window as any).showSaveFilePicker({
      suggestedName: name,
      types: [{ description: 'Zip file', accept: { 'application/zip': ['.zip'] } }],
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      return { ok: false, error: 'Đã huỷ — chưa chọn nơi lưu file.' };
    }
    return { ok: false, error: e?.message ?? 'Không mở được hộp thoại lưu file.' };
  }

  const writable = await handle.createWritable();

  // level: 0 — khớp lựa chọn của server hiện tại (archiver, level 0 trong
  // app/api/download/route.ts): phần lớn nội dung Drive (ảnh/video/pdf) đã nén
  // sẵn, nén thêm lần nữa gần như không lợi, chỉ tốn CPU của chính máy user.
  const zipWriter = new ZipWriter<unknown>(writable, {
    level: 0,
    zip64: true,
    useWebWorkers: true,
  });

  const skipped: { name: string; reason: string }[] = [];
  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) {
      // Huỷ hẳn writable — KHÔNG gọi zipWriter.close(), vì close() sẽ cố ghi
      // nốt central directory. abort() làm trình duyệt coi như file chưa từng
      // được tạo, đúng ý "huỷ" của người dùng thay vì âm thầm ghi tiếp.
      try {
        await writable.abort();
      } catch {
        /* best-effort — coi như đã huỷ dù abort() tự nó lỗi */
      }
      return { ok: false, error: 'Đã huỷ theo yêu cầu.', cancelled: true };
    }
    const f = files[i];
    onProgress({
      totalFiles: files.length,
      completedFiles: i,
      currentFileName: f.path,
      skipped: [...skipped],
      status: 'running',
    });
    try {
      const url = buildMediaUrl(f.id, resourceKey);
      const res = await fetchWithRetry(url, 3, signal);
      if (!res.ok || !res.body) {
        skipped.push({ name: f.path, reason: `HTTP ${res.status}` });
        continue;
      }
      await zipWriter.add(f.path, res.body);
    } catch (e: any) {
      skipped.push({ name: f.path, reason: e?.message ?? 'Lỗi không xác định' });
      try {
        // Dọn entry ghi dở nếu lỗi xảy ra giữa chừng stream — xem
        // ZipWriter#remove trong index.d.ts: entry hỏng không bị tham chiếu
        // trong central directory nữa (bytes rác vẫn nằm trong file, vô hại).
        zipWriter.remove(f.path);
      } catch {
        /* best-effort, bỏ qua nếu remove tự nó lỗi */
      }
    }
  }

  // Giữ tinh thần _file_bi_loi.txt hiện có ở server — báo lỗi minh bạch ngay
  // trong chính file zip, không im lặng bỏ qua file lỗi.
  if (skipped.length > 0) {
    const manifest = skipped.map((s) => `${s.name}: ${s.reason}`).join('\n');
    await zipWriter.add('_file_bi_loi.txt', new Blob([manifest]).stream());
  }

  await zipWriter.close();

  onProgress({
    totalFiles: files.length,
    completedFiles: files.length,
    currentFileName: null,
    skipped,
    status: 'done',
  });

  return { ok: true };
}
