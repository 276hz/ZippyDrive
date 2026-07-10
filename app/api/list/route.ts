import { NextRequest, NextResponse } from 'next/server';
import { parseDriveUrl, listFolderRecursive, getFileMeta, sanitize, finalExtName, maxTotalDownloadBytes } from '@/lib/drive';

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

  try {
    const { url } = await req.json();
    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'Thiếu link Google Drive.' }, { status: 400 });
    }

    const { type, id, resourceKey } = parseDriveUrl(url);

    if (type === 'file') {
      const meta = await getFileMeta(id, apiKey, resourceKey);
      const size = meta.size ? Number(meta.size) : null;
      const sizeLimit = maxTotalDownloadBytes();
      return NextResponse.json({
        isFolder: false,
        name: sanitize(meta.name),
        resourceKey: resourceKey ?? null,
        files: [
          {
            id: meta.id,
            path: finalExtName(sanitize(meta.name), meta.mimeType),
            mimeType: meta.mimeType,
            size: meta.size ?? null,
          },
        ],
        totalCount: 1,
        totalSize: size,
        sizeLimit,
        exceedsLimit: sizeLimit != null && size != null && size > sizeLimit,
      });
    }

    const meta = await getFileMeta(id, apiKey, resourceKey).catch(() => ({ name: 'GoogleDrive_Folder' } as any));
    const rawFiles = await listFolderRecursive(id, apiKey, '', resourceKey);

    const files = rawFiles.map((f) => ({
      id: f.id,
      path: finalExtName(f.path, f.mimeType),
      mimeType: f.mimeType,
      size: f.size ?? null,
    }));

    const totalSize = files.reduce((sum, f) => sum + (f.size ? Number(f.size) : 0), 0);
    const unknownSizeCount = files.filter((f) => !f.size).length;
    const sizeLimit = maxTotalDownloadBytes();

    return NextResponse.json({
      isFolder: true,
      name: sanitize(meta.name || 'GoogleDrive_Folder'),
      resourceKey: resourceKey ?? null,
      files,
      totalCount: files.length,
      totalSize,
      unknownSizeCount,
      sizeLimit,
      exceedsLimit: sizeLimit != null && totalSize > sizeLimit,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'Lỗi không xác định.' }, { status: 400 });
  }
}
