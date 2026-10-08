import { NextRequest, NextResponse } from 'next/server';
import {
  parseDriveUrl,
  resolveDriveTarget,
  listFolderRecursive,
  sanitize,
  finalExtName,
  maxTotalDownloadBytes,
  maxFilesPerDownload,
  uniquePaths,
  DriveLimitError,
} from '@/lib/drive';
import { listingLimiter, LISTING_BUSY_MESSAGE } from '@/lib/listing-limit';
import { errorMessage } from '@/lib/errors';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'Server chưa cấu hình biến môi trường GOOGLE_API_KEY.' },
      { status: 500 }
    );
  }

  // Quét thư mục tốn RAM + quota API: có trần đồng thời toàn server (xem lib/listing-limit.ts).
  const leave = listingLimiter.tryEnter();
  if (!leave) {
    return NextResponse.json({ error: LISTING_BUSY_MESSAGE }, { status: 503, headers: { 'Retry-After': '5' } });
  }

  try {
    const { url } = await req.json();
    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'Thiếu link Google Drive.' }, { status: 400 });
    }

    // `signal`: client đóng tab/huỷ thì dừng duyệt cây thư mục ngay, không gọi API tiếp.
    const target = await resolveDriveTarget(parseDriveUrl(url), apiKey, req.signal);

    if (target.type === 'file') {
      const { meta } = target;
      const size = meta.size ? Number(meta.size) : null;
      const sizeLimit = maxTotalDownloadBytes();
      return NextResponse.json({
        isFolder: false,
        name: sanitize(meta.name),
        files: [
          {
            id: meta.id,
            path: finalExtName(sanitize(meta.name), meta.mimeType),
            mimeType: meta.mimeType,
            resourceKey: target.resourceKey ?? null,
            size: meta.size ?? null,
          },
        ],
        totalCount: 1,
        totalSize: size,
        sizeLimit,
        exceedsLimit: sizeLimit != null && size != null && size > sizeLimit,
      });
    }

    // resourceKey được đọc và gắn ĐÚNG THEO TỪNG FILE ngay trong listFolderRecursive
    // (xem lib/drive.ts) — không có giá trị chung nào áp dụng cho cả folder.
    const rawFiles = await listFolderRecursive(target.id, apiKey, '', target.resourceKey, {
      signal: req.signal,
      maxFiles: maxFilesPerDownload(),
    });

    // uniquePaths: Drive cho phép nhiều file cùng tên trong 1 folder; danh sách này cũng là
    // tên entry của zip ở chế độ tải trực tiếp (B/C) nên phải duy nhất, không thì giải nén bị ghi đè.
    const files = uniquePaths(
      rawFiles.map((f) => ({
        id: f.id,
        path: finalExtName(f.path, f.mimeType),
        mimeType: f.mimeType,
        resourceKey: f.resourceKey ?? null,
        size: f.size ?? null,
      }))
    );

    const totalSize = files.reduce((sum, f) => sum + (f.size ? Number(f.size) : 0), 0);
    const unknownSizeCount = files.filter((f) => !f.size).length;
    const sizeLimit = maxTotalDownloadBytes();

    return NextResponse.json({
      isFolder: true,
      name: sanitize(target.meta?.name || 'GoogleDrive_Folder'),
      files,
      totalCount: files.length,
      totalSize,
      unknownSizeCount,
      sizeLimit,
      exceedsLimit: sizeLimit != null && totalSize > sizeLimit,
    });
  } catch (err: unknown) {
    if (err instanceof DriveLimitError) {
      return NextResponse.json({ error: err.message }, { status: 413 });
    }
    return NextResponse.json({ error: errorMessage(err, 'Lỗi không xác định.') }, { status: 400 });
  } finally {
    leave();
  }
}
