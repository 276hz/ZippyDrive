import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  parseDriveUrl,
  sanitize,
  finalExtName,
  contentDisposition,
  uniquePaths,
  isDriveId,
  buildDownloadRequest,
  getFileMeta,
  fetchWithRetry,
  listFolderRecursive,
  DriveLimitError,
  resolveDriveTarget,
  maxFilesPerDownload,
} from './drive.ts';

describe('parseDriveUrl', () => {
  test('nhận diện link folder dạng /drive/folders/ID', () => {
    const r = parseDriveUrl('https://drive.google.com/drive/folders/1a2B3c4D5e6F7g8H9i0J');
    assert.equal(r.type, 'folder');
    assert.equal(r.id, '1a2B3c4D5e6F7g8H9i0J');
  });

  test('nhận diện link folder có tiền tố /u/0/', () => {
    const r = parseDriveUrl('https://drive.google.com/drive/u/0/folders/1a2B3c4D5e6F7g8H9i0J');
    assert.equal(r.type, 'folder');
    assert.equal(r.id, '1a2B3c4D5e6F7g8H9i0J');
  });

  test('nhận diện link folder mobile /u/0/mobile/folders/', () => {
    const r = parseDriveUrl('https://drive.google.com/drive/u/0/mobile/folders/1a2B3c4D5e6F7g8H9i0J');
    assert.equal(r.type, 'folder');
    assert.equal(r.id, '1a2B3c4D5e6F7g8H9i0J');
  });

  test('nhận diện link file dạng /file/d/ID', () => {
    const r = parseDriveUrl('https://drive.google.com/file/d/1a2B3c4D5e6F7g8H9i0J/view?usp=sharing');
    assert.equal(r.type, 'file');
    assert.equal(r.id, '1a2B3c4D5e6F7g8H9i0J');
  });

  test('nhận diện link file dạng ?id=ID (kiểu open?id=)', () => {
    const r = parseDriveUrl('https://drive.google.com/open?id=1a2B3c4D5e6F7g8H9i0J');
    assert.equal(r.type, 'file');
    assert.equal(r.id, '1a2B3c4D5e6F7g8H9i0J');
  });

  test('bỏ qua usp=sharing / usp=drive_link không ảnh hưởng kết quả', () => {
    const a = parseDriveUrl('https://drive.google.com/file/d/1a2B3c4D5e6F7g8H9i0J/view?usp=sharing');
    const b = parseDriveUrl('https://drive.google.com/file/d/1a2B3c4D5e6F7g8H9i0J/view?usp=drive_link');
    assert.equal(a.id, b.id);
    assert.equal(a.type, b.type);
  });

  test('đọc đúng resourcekey từ query string', () => {
    const r = parseDriveUrl(
      'https://drive.google.com/file/d/1a2B3c4D5e6F7g8H9i0J/view?resourcekey=0-AbCdEfGhIjKlMn'
    );
    assert.equal(r.resourceKey, '0-AbCdEfGhIjKlMn');
  });

  test('resourceKey undefined khi không có trong URL', () => {
    const r = parseDriveUrl('https://drive.google.com/file/d/1a2B3c4D5e6F7g8H9i0J/view');
    assert.equal(r.resourceKey, undefined);
  });

  test('chấp nhận ID trần (không phải URL) như một folder', () => {
    const r = parseDriveUrl('1a2B3c4D5e6F7g8H9i0J');
    assert.equal(r.type, 'folder');
    assert.equal(r.id, '1a2B3c4D5e6F7g8H9i0J');
  });

  test('loại bỏ khoảng trắng thừa (đầu/cuối/giữa) và ký tự zero-width khi dán link', () => {
    const withNoise = '  https://drive.google.com/\u200Bfile/d/1a2B3c4D5e6F7g8H9i0J/view\uFEFF  ';
    const r = parseDriveUrl(withNoise);
    assert.equal(r.type, 'file');
    assert.equal(r.id, '1a2B3c4D5e6F7g8H9i0J');
  });

  test('BUG ĐÃ SỬA: từ chối domain giả dạng "drive.google.com.evil.com" dù path giống hệt link thật', () => {
    assert.throws(() => parseDriveUrl('https://drive.google.com.evil.com/drive/folders/1a2B3c4D5e6F7g8H9i0J'));
  });

  test('BUG ĐÃ SỬA: từ chối domain giả dạng "evil-drive.google.com.attacker.net"', () => {
    assert.throws(() =>
      parseDriveUrl('https://evil-drive.google.com.attacker.net/file/d/1a2B3c4D5e6F7g8H9i0J/view')
    );
  });

  test('từ chối URL hoàn toàn không liên quan tới Google Drive', () => {
    assert.throws(() => parseDriveUrl('https://example.com/foo/bar'));
  });

  test('từ chối chuỗi rác không phải URL cũng không phải ID hợp lệ', () => {
    assert.throws(() => parseDriveUrl('không phải link gì cả!!!'));
  });

  test('từ chối chuỗi rỗng', () => {
    assert.throws(() => parseDriveUrl(''));
  });

  test('từ chối đúng domain Drive nhưng path không nhận diện được (vd. trang chủ)', () => {
    assert.throws(() => parseDriveUrl('https://drive.google.com/drive/my-drive'));
  });
});

describe('sanitize — an toàn tên file/folder', () => {
  test('giữ nguyên tên Unicode hợp lệ (tiếng Việt, Trung, Nhật)', () => {
    assert.equal(sanitize('Báo cáo quý 3.pdf'), 'Báo cáo quý 3.pdf');
    assert.equal(sanitize('报告.pdf'), '报告.pdf');
    assert.equal(sanitize('レポート.pdf'), 'レポート.pdf');
  });

  test('thay ký tự Windows cấm bằng "_"', () => {
    assert.equal(sanitize('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  });

  test('BUG ĐÃ SỬA: "." dùng làm tên nguyên vẹn phải bị vô hiệu hoá (path traversal khi giải nén zip)', () => {
    const result = sanitize('.');
    assert.notEqual(result, '.', 'không được để lọt "." nguyên vẹn — rủi ro path traversal trong zip entry');
  });

  test('BUG ĐÃ SỬA: ".." dùng làm tên nguyên vẹn phải bị vô hiệu hoá (path traversal khi giải nén zip)', () => {
    const result = sanitize('..');
    assert.notEqual(result, '..', 'không được để lọt ".." nguyên vẹn — rủi ro path traversal trong zip entry');
  });

  test('tên thường chứa dấu chấm (không phải "." hay ".." thuần) vẫn giữ nguyên', () => {
    assert.equal(sanitize('v1.2.3'), 'v1.2.3');
    assert.equal(sanitize('...ellipsis-start'), '...ellipsis-start');
  });

  test('BUG ĐÃ SỬA: dấu chấm/khoảng trắng ở cuối tên bị strip (Windows tự strip khi tạo file)', () => {
    assert.equal(sanitize('bao-cao...'), 'bao-cao');
    assert.equal(sanitize('bao-cao   '), 'bao-cao');
    assert.equal(sanitize('bao-cao. . .'), 'bao-cao');
  });

  test('BUG ĐÃ SỬA: tên thiết bị dành riêng của Windows bị đổi tên, kể cả không hoa/thường', () => {
    assert.equal(sanitize('CON'), 'CON_');
    assert.equal(sanitize('con'), 'con_');
    assert.equal(sanitize('con.txt'), 'con_.txt');
    assert.equal(sanitize('COM1'), 'COM1_');
    assert.equal(sanitize('lpt9.log'), 'lpt9_.log');
  });

  test('tên chỉ GIỐNG một phần tên thiết bị dành riêng không bị đổi (chỉ chặn khớp chính xác)', () => {
    assert.equal(sanitize('CONTRACT.pdf'), 'CONTRACT.pdf');
    assert.equal(sanitize('economics.pdf'), 'economics.pdf');
  });

  test('chuỗi rỗng hoặc toàn khoảng trắng fallback về "untitled"', () => {
    assert.equal(sanitize(''), 'untitled');
    assert.equal(sanitize('   '), 'untitled');
  });

  test('ký tự điều khiển (control chars) bị thay bằng "_"', () => {
    assert.equal(sanitize('a\x00b\x1fc'), 'a_b_c');
  });
});

describe('finalExtName — export Google Docs/Sheets/Slides', () => {
  test('thêm đúng phần mở rộng cho Google Docs (chưa có extension)', () => {
    assert.equal(finalExtName('Bao cao', 'application/vnd.google-apps.document'), 'Bao cao.docx');
  });

  test('thêm đúng phần mở rộng cho Google Sheets', () => {
    assert.equal(finalExtName('So lieu', 'application/vnd.google-apps.spreadsheet'), 'So lieu.xlsx');
  });

  test('thêm đúng phần mở rộng cho Google Slides', () => {
    assert.equal(finalExtName('Thuyet trinh', 'application/vnd.google-apps.presentation'), 'Thuyet trinh.pptx');
  });

  test('file thường (không phải Google-native) giữ nguyên path, không đổi gì', () => {
    assert.equal(finalExtName('anh.jpg', 'image/jpeg'), 'anh.jpg');
    assert.equal(finalExtName('video.mp4', 'video/mp4'), 'video.mp4');
  });

  test('thay đúng extension cũ (nếu path Google Docs lỡ có extension) thay vì nối chồng', () => {
    const result = finalExtName('Bao cao.gdoc', 'application/vnd.google-apps.document');
    assert.equal(result, 'Bao cao.docx');
  });
});

describe('contentDisposition — an toàn header, chống CRLF injection', () => {
  test('tên file thường tạo header hợp lệ, có cả bản ASCII fallback và UTF-8', () => {
    const header = contentDisposition('report.pdf');
    assert.match(header, /^attachment; filename="report\.pdf"; filename\*=UTF-8''/);
  });

  test('giữ đúng ký tự Unicode (tiếng Việt) ở phần filename* (RFC 5987)', () => {
    const header = contentDisposition('Báo cáo.pdf');
    assert.ok(header.includes(encodeURIComponent('Báo cáo.pdf')));
  });

  test('xác nhận an toàn: CR/LF trong tên file không tạo được header injection', () => {
    const malicious = 'evil\r\nSet-Cookie: hacked=true';
    const header = contentDisposition(malicious);
    // Không được có CR/LF thật (0x0D/0x0A) nằm trong chuỗi header cuối cùng —
    // cả 2 phần (ascii fallback lẫn filename* RFC 5987) đều phải trung hoà.
    assert.ok(!header.includes('\r'), 'không được còn CR thật trong header');
    assert.ok(!header.includes('\n'), 'không được còn LF thật trong header');
  });

  test('dấu ngoặc kép trong tên file không phá vỡ cấu trúc quoted-string của header', () => {
    const header = contentDisposition('file"with"quotes.txt');
    // Không được có dấu " nào KHÔNG PHẢI 2 dấu bao quanh filename="..."
    const asciiPart = header.match(/filename="([^]*?)"; filename\*/)?.[1] ?? '';
    assert.ok(!asciiPart.includes('"'), 'dấu " bên trong tên file phải được thay thế, không giữ nguyên');
  });
});

// ───────────────────────────── bổ sung: các lỗi tìm thấy khi rà soát ─────────────────────────────

const DOC = 'application/vnd.google-apps.document';

describe('parseDriveUrl — ID trần không dung khoảng trắng nội bộ', () => {
  test('câu văn bình thường KHÔNG bị gộp thành "ID" folder', () => {
    assert.throws(() => parseDriveUrl('not a drive link'));
    assert.throws(() => parseDriveUrl('please download my holiday photos'));
    assert.throws(() => parseDriveUrl('khong phai link gi ca'));
  });

  test('ID trần hợp lệ vẫn được nhận (kể cả khoảng trắng/ký tự ẩn hai đầu)', () => {
    assert.deepEqual(parseDriveUrl('  1a2B3c4D5e6F7g8H9i0J \n'), { type: 'folder', id: '1a2B3c4D5e6F7g8H9i0J' });
    assert.equal(parseDriveUrl('\u200B1a2B3c4D5e6F7g8H9i0J\uFEFF').id, '1a2B3c4D5e6F7g8H9i0J');
  });

  test('link URL bị xuống dòng giữa chừng khi dán vẫn được nhận', () => {
    const r = parseDriveUrl('https://drive.google.com/drive/fol\nders/1a2B3c4D5e6F7g8H9i0J');
    assert.equal(r.type, 'folder');
    assert.equal(r.id, '1a2B3c4D5e6F7g8H9i0J');
  });
});

describe('sanitize — "." và ".." luôn thành "untitled"', () => {
  test('không bao giờ trả về "." / ".."', () => {
    assert.equal(sanitize('.'), 'untitled');
    assert.equal(sanitize('..'), 'untitled');
    assert.equal(sanitize(' . '), 'untitled');
  });
});

describe('finalExtName — dấu chấm trong TÊN không bị coi là phần mở rộng', () => {
  test('giữ nguyên các phần sau dấu chấm của tên và nối thêm đuôi', () => {
    assert.equal(finalExtName('Meeting notes v1.2', DOC), 'Meeting notes v1.2.docx');
    assert.equal(finalExtName('Budget 2024.05', DOC), 'Budget 2024.05.docx');
    assert.equal(finalExtName('Hop 12.03.2024', DOC), 'Hop 12.03.2024.docx');
  });

  test('"Notes 1.5" và "Notes 1.6" KHÔNG còn trùng nhau', () => {
    assert.notEqual(finalExtName('Notes 1.5', DOC), finalExtName('Notes 1.6', DOC));
  });

  test('đã đúng đuôi đích thì giữ nguyên (không thành .docx.docx), không phân biệt hoa/thường', () => {
    assert.equal(finalExtName('Report.docx', DOC), 'Report.docx');
    assert.equal(finalExtName('REPORT.DOCX', DOC), 'REPORT.DOCX');
  });

  test('đuôi con trỏ của Google Drive (.gdoc/.gsheet/.gslides) được thay đúng', () => {
    assert.equal(finalExtName('a.gdoc', DOC), 'a.docx');
    assert.equal(finalExtName('b.GSHEET', 'application/vnd.google-apps.spreadsheet'), 'b.xlsx');
    assert.equal(finalExtName('c.gslides', 'application/vnd.google-apps.presentation'), 'c.pptx');
  });

  test('đuôi khác (vd. .pdf) là một phần của tên → nối thêm đuôi', () => {
    assert.equal(finalExtName('report.pdf', DOC), 'report.pdf.docx');
  });

  test('đường dẫn có thư mục: chỉ xét đuôi của thành phần cuối', () => {
    assert.equal(finalExtName('v1.2/Report', DOC), 'v1.2/Report.docx');
  });
});

describe('uniquePaths — không còn entry trùng tên trong zip', () => {
  const f = (path: string) => ({ path });
  const paths = (xs: { path: string }[]) => xs.map((x) => x.path);

  test('hai file cùng tên → bản sau thành "(2)", bản đầu giữ nguyên', () => {
    assert.deepEqual(paths(uniquePaths([f('photo.jpg'), f('photo.jpg'), f('photo.jpg')])), [
      'photo.jpg',
      'photo (2).jpg',
      'photo (3).jpg',
    ]);
  });

  test('trùng không phân biệt hoa/thường (Windows/macOS coi là một file)', () => {
    assert.deepEqual(paths(uniquePaths([f('IMG.JPG'), f('img.jpg')])), ['IMG.JPG', 'img (2).jpg']);
  });

  test('chuẩn hoá Unicode: NFC và NFD của cùng một tên là một file', () => {
    const nfc = 'Việt.txt'.normalize('NFC');
    const nfd = 'Việt.txt'.normalize('NFD');
    const out = uniquePaths([f(nfc), f(nfd)]);
    assert.equal(out[0].path, nfc);
    assert.notEqual(out[1].path.normalize('NFC').toLowerCase(), nfc.toLowerCase());
  });

  test('va chạm do sanitize/finalExtName: "a_b" (từ "a/b") và "a_b"; Doc "Report" và file "Report.docx"', () => {
    const out = paths(uniquePaths([f(sanitize('a/b')), f('a_b'), f(finalExtName('Report', DOC)), f('Report.docx')]));
    assert.equal(new Set(out.map((x) => x.toLowerCase())).size, 4);
  });

  test('chỉ đổi tên trong cùng thư mục; thư mục con giữ nguyên', () => {
    assert.deepEqual(paths(uniquePaths([f('d/x.txt'), f('d/x.txt'), f('e/x.txt')])), ['d/x.txt', 'd/x (2).txt', 'e/x.txt']);
  });

  test('file không được trùng tên với một THƯ MỤC có trong danh sách', () => {
    const out = paths(uniquePaths([f('docs'), f('docs/a.txt')]));
    assert.equal(out[1], 'docs/a.txt');
    assert.equal(out[0], 'docs (2)');
  });

  test('tên sinh ra không đè lên tên gốc của file khác', () => {
    // "a (2).txt" là tên gốc của file thứ 3 → bản trùng thứ 2 phải nhảy sang "(3)".
    assert.deepEqual(paths(uniquePaths([f('a.txt'), f('a.txt'), f('a (2).txt')])), ['a.txt', 'a (3).txt', 'a (2).txt']);
  });

  test('file ẩn (.gitignore) không bị coi là có đuôi; giữ nguyên thứ tự, không sửa mảng gốc', () => {
    const input = [f('.gitignore'), f('.gitignore')];
    const out = uniquePaths(input);
    assert.deepEqual(paths(out), ['.gitignore', '.gitignore (2)']);
    assert.deepEqual(paths(input), ['.gitignore', '.gitignore']);
  });

  test('giữ nguyên các thuộc tính khác của phần tử và trả về cùng tham chiếu nếu không đổi', () => {
    const a = { path: 'a.txt', id: '1' };
    const b = { path: 'a.txt', id: '2' };
    const out = uniquePaths([a, b]);
    assert.equal(out[0], a);
    assert.deepEqual(out[1], { path: 'a (2).txt', id: '2' });
  });
});

describe('isDriveId / chống path traversal vào www.googleapis.com', () => {
  test('chỉ nhận ID đúng bảng ký tự và độ dài', () => {
    assert.equal(isDriveId('1a2B3c4D5e6F7g8H9i0J'), true);
    assert.equal(isDriveId('abc'), false);
    assert.equal(isDriveId('../../../youtube/v3/search?q=x#'), false);
    assert.equal(isDriveId("x'  or name contains 'a"), false);
  });

  test('buildDownloadRequest ném lỗi với ID độc hại thay vì dựng URL', () => {
    assert.throws(() => buildDownloadRequest('../../../youtube/v3/search?q=x#', '', 'KEY'), /không hợp lệ/);
    assert.throws(() => buildDownloadRequest('../about', DOC, 'KEY'), /không hợp lệ/);
  });

  test('buildDownloadRequest với ID hợp lệ vẫn đúng host/path', () => {
    const r = buildDownloadRequest('1a2B3c4D5e6F7g8H9i0J', '', 'KEY');
    assert.ok(r);
    assert.equal(r.url.host, 'www.googleapis.com');
    assert.equal(r.url.pathname, '/drive/v3/files/1a2B3c4D5e6F7g8H9i0J');
  });

  test('getFileMeta / listFolderRecursive từ chối ID sai TRƯỚC khi gọi mạng', async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{}');
    }) as typeof fetch;
    try {
      await assert.rejects(() => getFileMeta('../about', 'K'), /không hợp lệ/);
      await assert.rejects(() => listFolderRecursive("x' or '1'='1", 'K'), /không hợp lệ/);
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('fetchWithRetry (server) — phân biệt 403 rate-limit và 403 quyền', () => {
  const realFetch = globalThis.fetch;
  const json = (o: unknown, status: number) =>
    new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const rateLimit403 = () => json({ error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } }, 403);
  const forbidden403 = () => json({ error: { code: 403, errors: [{ reason: 'forbidden' }] } }, 403);

  test('403 rateLimitExceeded/userRateLimitExceeded được thử lại rồi thành công', async () => {
    let calls = 0;
    globalThis.fetch = (async () => (++calls === 1 ? rateLimit403() : json({ ok: true }, 200))) as typeof fetch;
    try {
      const res = await fetchWithRetry('https://example.invalid/x', undefined, 3);
      assert.equal(res.status, 200);
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('403 do không có quyền KHÔNG thử lại (thử lại cũng vô ích)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => (calls++, forbidden403())) as typeof fetch;
    try {
      const res = await fetchWithRetry('https://example.invalid/x', undefined, 3);
      assert.equal(res.status, 403);
      assert.equal(calls, 1);
      assert.match(await res.text(), /forbidden/, 'body 403 trả về vẫn đọc được nguyên vẹn');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('404 không thử lại; signal đã abort thì ném AbortError ngay, không gọi mạng', async () => {
    let calls = 0;
    globalThis.fetch = (async () => (calls++, json({}, 404))) as typeof fetch;
    try {
      assert.equal((await fetchWithRetry('https://example.invalid/x', undefined, 3)).status, 404);
      assert.equal(calls, 1);
      calls = 0;
      await assert.rejects(() => fetchWithRetry('https://example.invalid/x', undefined, 3, AbortSignal.abort()), { name: 'AbortError' });
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('listFolderRecursive — trần số file, huỷ giữa chừng, phân trang', () => {
  const realFetch = globalThis.fetch;
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const mk = (n: number, prefix = 'f') =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}${String(i).padStart(11, '0')}`, name: `${prefix}${i}.txt`, mimeType: 'text/plain' }));

  test('vượt maxFiles → DriveLimitError (và dừng sớm, không duyệt hết)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => (calls++, json({ files: mk(50), nextPageToken: 'more' }))) as typeof fetch;
    try {
      await assert.rejects(() => listFolderRecursive('ROOTfolder01', 'K', '', undefined, { maxFiles: 120 }), DriveLimitError);
      assert.equal(calls, 3, 'dừng ngay ở trang thứ 3 (150 > 120), không đi tiếp vô tận');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('đúng bằng maxFiles thì vẫn được', async () => {
    globalThis.fetch = (async () => json({ files: mk(5) })) as typeof fetch;
    try {
      assert.equal((await listFolderRecursive('ROOTfolder01', 'K', '', undefined, { maxFiles: 5 })).length, 5);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('signal đã abort → AbortError, không gọi API', async () => {
    let calls = 0;
    globalThis.fetch = (async () => (calls++, json({ files: [] }))) as typeof fetch;
    try {
      await assert.rejects(() => listFolderRecursive('ROOTfolder01', 'K', '', undefined, { signal: AbortSignal.abort() }), {
        name: 'AbortError',
      });
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('thứ tự: file của subfolder nằm đúng chỗ, phân trang đủ, resourceKey riêng từng item', async () => {
    const seen: { q: string | null; page: string | null; rk: string | null }[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const q = u.searchParams.get('q')!;
      const page = u.searchParams.get('pageToken');
      const rk = (init?.headers as Record<string, string> | undefined)?.['X-Goog-Drive-Resource-Keys'] ?? null;
      seen.push({ q, page, rk });
      if (q.includes("'ROOTfolder01'"))
        return page
          ? json({ files: [{ id: 'fileB00000001', name: 'b.txt', mimeType: 'text/plain' }] })
          : json({
              nextPageToken: 'P2',
              files: [
                { id: 'fileA00000001', name: 'a.txt', mimeType: 'text/plain', resourceKey: 'rkA' },
                { id: 'SUBfolder0001', name: 'Sub', mimeType: 'application/vnd.google-apps.folder', resourceKey: 'rkSub' },
              ],
            });
      return json({ files: [{ id: 'fileC00000001', name: 'c.txt', mimeType: 'text/plain' }] });
    }) as typeof fetch;
    try {
      const out = await listFolderRecursive('ROOTfolder01', 'K', '', 'rkRoot');
      assert.deepEqual(out.map((f) => f.path), ['a.txt', 'Sub/c.txt', 'b.txt']);
      assert.equal(out[0].resourceKey, 'rkA');
      assert.deepEqual(seen.map((s) => s.rk), ['ROOTfolder01/rkRoot', 'SUBfolder0001/rkSub', 'ROOTfolder01/rkRoot']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('resolveDriveTarget — ID trần là FILE không còn bị coi nhầm là folder rỗng', () => {
  const realFetch = globalThis.fetch;
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const ID = '1a2B3c4D5e6F7g8H9i0J';

  test('ID trần (parse ra "folder") nhưng thực chất là file → type "file" kèm metadata', async () => {
    globalThis.fetch = (async () => json({ id: ID, name: 'a.pdf', mimeType: 'application/pdf', size: '10' })) as typeof fetch;
    try {
      const t = await resolveDriveTarget(parseDriveUrl(ID), 'K');
      assert.equal(t.type, 'file');
      assert.equal(t.meta?.name, 'a.pdf');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('link folder thật → vẫn là "folder"', async () => {
    globalThis.fetch = (async () => json({ id: ID, name: 'Anh', mimeType: 'application/vnd.google-apps.folder' })) as typeof fetch;
    try {
      const t = await resolveDriveTarget(parseDriveUrl(`https://drive.google.com/drive/folders/${ID}`), 'K');
      assert.equal(t.type, 'folder');
      assert.equal(t.meta?.name, 'Anh');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('folder mà đọc metadata lỗi → vẫn "folder" với meta=null (vẫn liệt kê được, chỉ thiếu tên)', async () => {
    globalThis.fetch = (async () => json({ error: { code: 403 } }, 403)) as typeof fetch;
    try {
      const t = await resolveDriveTarget(parseDriveUrl(`https://drive.google.com/drive/folders/${ID}`), 'K');
      assert.equal(t.type, 'folder');
      assert.equal(t.meta, null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('link FILE mà đọc metadata lỗi → ném lỗi (không có gì để tải)', async () => {
    globalThis.fetch = (async () => json({ error: { code: 404 } }, 404)) as typeof fetch;
    try {
      await assert.rejects(() => resolveDriveTarget(parseDriveUrl(`https://drive.google.com/file/d/${ID}/view`), 'K'), /404/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('client huỷ giữa chừng → ném AbortError thay vì nuốt lỗi', async () => {
    const ac = new AbortController();
    globalThis.fetch = (async () => {
      ac.abort();
      throw new DOMException('aborted', 'AbortError');
    }) as typeof fetch;
    try {
      await assert.rejects(() => resolveDriveTarget(parseDriveUrl(ID), 'K', ac.signal), { name: 'AbortError' });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('maxFilesPerDownload — trần số file đọc từ env', () => {
  const ORIGINAL = process.env.MAX_FILES_PER_DOWNLOAD;
  const withEnv = (v: string | undefined) => {
    if (v === undefined) delete process.env.MAX_FILES_PER_DOWNLOAD;
    else process.env.MAX_FILES_PER_DOWNLOAD = v;
    try {
      return maxFilesPerDownload();
    } finally {
      if (ORIGINAL === undefined) delete process.env.MAX_FILES_PER_DOWNLOAD;
      else process.env.MAX_FILES_PER_DOWNLOAD = ORIGINAL;
    }
  };
  test('mặc định 20.000; hợp lệ dùng đúng; rác → mặc định', () => {
    assert.equal(withEnv(undefined), 20000);
    assert.equal(withEnv('500'), 500);
    assert.equal(withEnv(''), 20000);
    assert.equal(withEnv('abc'), 20000);
    assert.equal(withEnv('-1'), 20000);
  });
});
