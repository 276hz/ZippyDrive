import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { parseDriveUrl, sanitize, finalExtName, contentDisposition } from './drive.ts';

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
