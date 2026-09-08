import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Các hàm cần test là internal (không export) vì không cần dùng ngoài module —
// import cả module rồi gọi qua export public để test hành vi quan sát được từ
// bên ngoài, đúng tinh thần "test hành vi, không test implementation detail".
import {
  directDownloadEnabled,
  buildMediaUrl,
  fetchWithRetry,
  downloadFileDirect,
  downloadFolderDirect,
} from './client-drive.ts';

describe('directDownloadEnabled', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT;
  });

  test('false khi chưa set biến môi trường — mặc định tính năng ẩn', () => {
    delete process.env.NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT;
    assert.strictEqual(directDownloadEnabled(), false);
  });

  test('true khi đã set biến môi trường', () => {
    process.env.NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT = 'fake-key-for-test';
    assert.strictEqual(directDownloadEnabled(), true);
  });
});

describe('buildMediaUrl', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT = 'TEST_CLIENT_KEY';
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT;
  });

  test('URL trỏ đúng tới googleapis.com/drive/v3, kèm alt=media và key', () => {
    const url = buildMediaUrl('FILE_ID_123');
    const parsed = new URL(url);
    assert.strictEqual(parsed.origin, 'https://www.googleapis.com');
    assert.strictEqual(parsed.pathname, '/drive/v3/files/FILE_ID_123');
    assert.strictEqual(parsed.searchParams.get('alt'), 'media');
    assert.strictEqual(parsed.searchParams.get('key'), 'TEST_CLIENT_KEY');
  });

  test('fileId có ký tự đặc biệt được encode đúng trong path', () => {
    const url = buildMediaUrl('abc/def?123');
    assert.ok(url.includes('abc%2Fdef%3F123'), `URL không encode đúng: ${url}`);
  });

  test('resourceKey chỉ xuất hiện khi được truyền vào', () => {
    const withoutRk = buildMediaUrl('FID');
    assert.strictEqual(new URL(withoutRk).searchParams.has('resourceKey'), false);

    const withRk = buildMediaUrl('FID', 'RK_VALUE');
    assert.strictEqual(new URL(withRk).searchParams.get('resourceKey'), 'RK_VALUE');
  });

  test('ném lỗi rõ ràng nếu gọi khi chưa cấu hình client key', () => {
    delete process.env.NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT;
    assert.throws(() => buildMediaUrl('FID'), /NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT/);
  });
});

describe('fetchWithRetry', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('trả về ngay khi request thành công lần đầu, không retry thừa', async () => {
    let calls = 0;
    globalThis.fetch = mock.fn(async () => {
      calls++;
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchWithRetry('https://example.invalid/x', 3);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls, 1, 'không nên gọi lại khi đã thành công');
  });

  test('KHÔNG retry với lỗi 403/404 — trả thẳng response lỗi (đúng lý do: retry không đổi được kết quả)', async () => {
    let calls = 0;
    globalThis.fetch = mock.fn(async () => {
      calls++;
      return new Response('forbidden', { status: 403 });
    }) as unknown as typeof fetch;

    const res = await fetchWithRetry('https://example.invalid/x', 3);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(calls, 1, 'lỗi 403 không nên retry — đây là bug nếu calls > 1');
  });

  test('CÓ retry với lỗi 5xx, thử lại tới khi hết số lần cho phép', async () => {
    let calls = 0;
    globalThis.fetch = mock.fn(async () => {
      calls++;
      return new Response('server error', { status: 500 });
    }) as unknown as typeof fetch;

    await assert.rejects(() => fetchWithRetry('https://example.invalid/x', 3));
    assert.strictEqual(calls, 3, `phải thử đúng 3 lần theo tham số attempts, thực tế: ${calls}`);
  });

  test('phục hồi thành công nếu lần thử sau (sau khi network lỗi) trả về OK', async () => {
    let calls = 0;
    globalThis.fetch = mock.fn(async () => {
      calls++;
      if (calls === 1) throw new TypeError('Failed to fetch'); // giả lập lỗi network/CORS
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchWithRetry('https://example.invalid/x', 3);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls, 2);
  });

  test('BUG ĐÃ SỬA: AbortSignal phải được ném ngay, KHÔNG retry — trước đây signal không hề được truyền vào fetch() nên nút "Huỷ tải" không có tác dụng gì', async () => {
    let calls = 0;
    globalThis.fetch = mock.fn(async (_url: string, init?: RequestInit) => {
      calls++;
      // Mô phỏng hành vi thật của fetch(): nếu signal đã abort, ném AbortError.
      if (init?.signal?.aborted) {
        const err = new DOMException('The operation was aborted.', 'AbortError');
        throw err;
      }
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => fetchWithRetry('https://example.invalid/x', 3, controller.signal),
      (err: unknown) => err instanceof DOMException && err.name === 'AbortError'
    );
    assert.strictEqual(calls, 1, 'AbortError không được retry — phải ném ngay từ lần gọi đầu tiên');
  });
});

describe('downloadFolderDirect — vòng lặp phải DỪNG THẬT khi bị huỷ giữa chừng', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT = 'TEST_KEY';
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT;
  });

  test('BUG ĐÃ SỬA: huỷ ở file thứ 2 trong danh sách 5 file thì KHÔNG được tải tiếp các file còn lại', async () => {
    let calls = 0;
    const controller = new AbortController();
    globalThis.fetch = mock.fn(async () => {
      calls++;
      if (calls === 2) controller.abort(); // giả lập người dùng bấm "Huỷ tải" giữa chừng
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const files = Array.from({ length: 5 }, (_, i) => ({
      id: `id-${i}`,
      path: `file-${i}.bin`,
      mimeType: 'application/octet-stream',
      size: 1,
    }));

    const progressUpdates: string[] = [];
    const result = await downloadFolderDirect(files, null, (p) => {
      if (p.currentFileName) progressUpdates.push(p.currentFileName);
    }, controller.signal);

    assert.strictEqual(result.cancelled, true, 'phải báo cancelled=true để caller không hiện thông báo "đã xong" sai');
    assert.strictEqual(calls, 2, `vòng lặp phải dừng ngay ở lần kiểm tra kế tiếp sau khi abort — thực tế đã gọi fetch ${calls} lần trên tổng 5 file`);
  });
});

describe('downloadFileDirect — xử lý lỗi nghiệp vụ từ Google (không phải lỗi network)', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT = 'TEST_KEY';
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT;
  });

  test('parse đúng message lỗi JSON của Google (kiểu lỗi "Only files with binary content" đã gặp thật khi test PoC)', async () => {
    globalThis.fetch = mock.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: 403, message: 'Only files with binary content can be downloaded.' } }),
        { status: 403 }
      )
    ) as unknown as typeof fetch;

    const result = await downloadFileDirect({ id: 'X', path: 'a.pdf', mimeType: 'application/pdf', size: 1 });
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.error, 'Only files with binary content can be downloaded.');
    }
  });

  test('fallback về "HTTP {status}" nếu body lỗi không phải JSON hợp lệ', async () => {
    globalThis.fetch = mock.fn(async () => new Response('not json', { status: 500 })) as unknown as typeof fetch;

    const result = await downloadFileDirect({ id: 'X', path: 'a.pdf', mimeType: 'application/pdf', size: 1 });
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.error, 'HTTP 500');
    }
  });
});
