import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Các hàm cần test là internal (không export) vì không cần dùng ngoài module —
// import cả module rồi gọi qua export public để test hành vi quan sát được từ
// bên ngoài, đúng tinh thần "test hành vi, không test implementation detail".
import {
  directDownloadEnabled,
  buildMediaUrl,
  buildClientDownloadUrl,
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
    const result = await downloadFolderDirect(files, (p) => {
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

  test('parse đúng message lỗi JSON của Google (ví dụ lỗi "Only files with binary content")', async () => {
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

describe('buildMediaUrl — chế độ trực tiếp cũng hỗ trợ Shared Drive', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT = 'TEST_CLIENT_KEY';
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT;
  });

  test('có supportsAllDrives=true (thiếu thì file trong Shared Drive trả 404)', () => {
    assert.strictEqual(new URL(buildMediaUrl('FILE_ID_123')).searchParams.get('supportsAllDrives'), 'true');
  });
});

describe('buildClientDownloadUrl — Docs/Sheets/Slides phải được EXPORT, không phải alt=media', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT = 'TEST_CLIENT_KEY';
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT;
  });

  const f = (mimeType: string, resourceKey?: string) => ({ id: 'FILE_ID_123', mimeType, resourceKey });

  test('Google Doc → /export với mimeType .docx (trước đây: alt=media → 403 "Only files with binary content")', () => {
    const u = new URL(buildClientDownloadUrl(f('application/vnd.google-apps.document'))!);
    assert.strictEqual(u.pathname, '/drive/v3/files/FILE_ID_123/export');
    assert.strictEqual(u.searchParams.get('mimeType'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.strictEqual(u.searchParams.get('key'), 'TEST_CLIENT_KEY');
    assert.strictEqual(u.searchParams.get('alt'), null);
  });

  test('Sheets → xlsx, Slides → pptx, Drawings → png', () => {
    const mime = (m: string) => new URL(buildClientDownloadUrl(f(m))!).searchParams.get('mimeType');
    assert.match(mime('application/vnd.google-apps.spreadsheet')!, /spreadsheetml\.sheet$/);
    assert.match(mime('application/vnd.google-apps.presentation')!, /presentationml\.presentation$/);
    assert.strictEqual(mime('application/vnd.google-apps.drawing'), 'image/png');
  });

  test('file thường → alt=media như cũ', () => {
    const u = new URL(buildClientDownloadUrl(f('application/pdf', 'rk1'))!);
    assert.strictEqual(u.pathname, '/drive/v3/files/FILE_ID_123');
    assert.strictEqual(u.searchParams.get('alt'), 'media');
    assert.strictEqual(u.searchParams.get('resourceKey'), 'rk1');
  });

  test('Forms / Sites / shortcut (không tải được) → null, không gọi API vô ích', () => {
    for (const m of ['application/vnd.google-apps.form', 'application/vnd.google-apps.site', 'application/vnd.google-apps.shortcut']) {
      assert.strictEqual(buildClientDownloadUrl(f(m)), null, m);
    }
  });

  test('thiếu client key → ném lỗi rõ ràng (cả nhánh export)', () => {
    delete process.env.NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT;
    assert.throws(() => buildClientDownloadUrl(f('application/vnd.google-apps.document')), /NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT/);
  });
});

describe('fetchWithRetry (client) — rate limit 429 / 403 được thử lại', () => {
  afterEach(() => mock.restoreAll());
  const json = (o: unknown, status: number) =>
    new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

  test('429 → thử lại rồi thành công (trước đây coi mọi 4xx là lỗi nghiệp vụ, không retry)', async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => (++calls === 1 ? json({ error: { code: 429 } }, 429) : json({ ok: 1 }, 200)));
    const res = await fetchWithRetry('https://example.invalid/x', 2);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls, 2);
  });

  test('403 rateLimitExceeded → thử lại rồi thành công', async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async () =>
      ++calls === 1 ? json({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, 403) : json({ ok: 1 }, 200)
    );
    const res = await fetchWithRetry('https://example.invalid/x', 2);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls, 2);
  });

  test('403 do không có quyền → KHÔNG thử lại', async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => (calls++, json({ error: { errors: [{ reason: 'forbidden' }] } }, 403)));
    const res = await fetchWithRetry('https://example.invalid/x', 3);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(calls, 1);
  });

  test('hết lượt mà vẫn 429 → trả nguyên response (để đọc thông điệp Google), không ném', async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => (calls++, json({ error: { message: 'Rate Limit Exceeded' } }, 429)));
    const res = await fetchWithRetry('https://example.invalid/x', 2);
    assert.strictEqual(res.status, 429);
    assert.strictEqual(calls, 2);
    assert.match(await res.text(), /Rate Limit Exceeded/);
  });
});

describe('downloadFileDirect — loại Google không tải được / export đúng URL', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT = 'TEST_CLIENT_KEY';
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_GOOGLE_API_KEY_CLIENT;
    mock.restoreAll();
  });

  test('Google Form → lỗi rõ ràng, KHÔNG gọi mạng', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('x'));
    const r = await downloadFileDirect({ id: 'FILE_ID_123', path: 'survey', mimeType: 'application/vnd.google-apps.form', size: null });
    assert.strictEqual(r.ok, false);
    assert.match((r as { error: string }).error, /không thể tải/);
    assert.strictEqual(fetchMock.mock.callCount(), 0);
  });

  test('Google Doc → gọi đúng endpoint export', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'x' } }), { status: 404 }));
    await downloadFileDirect({ id: 'FILE_ID_123', path: 'Bao cao.docx', mimeType: 'application/vnd.google-apps.document', size: null });
    assert.match(String(fetchMock.mock.calls[0].arguments[0]), /\/files\/FILE_ID_123\/export\?/);
  });
});
