import assert from 'node:assert/strict';
import { test, describe, type TestContext } from 'node:test';
import {
  createProgress,
  updateProgress,
  addSkipped,
  finishProgress,
  getProgress,
  touchProgress,
  isValidToken,
} from './progress-store.ts';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** Đồng hồ giả: test tự điều khiển `Date.now()` (t.mock tự khôi phục khi test xong). */
function fakeClock(t: TestContext, start = 1_700_000_000_000) {
  let now = start;
  t.mock.method(Date, 'now', () => now);
  return {
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('progress-store — dọn rác KHÔNG được xoá phiên đang chạy', () => {
  test('BUG ĐÃ SỬA: lượt tải chạy > 30 phút không bị xoá khi người khác bắt đầu tải', (t) => {
    const clock = fakeClock(t);
    createProgress('long-job', 5000, 'running');
    updateProgress('long-job', { completedFiles: 1200 });

    clock.advance(31 * MIN);
    updateProgress('long-job', { completedFiles: 1300 }); // vẫn đang có động tĩnh
    clock.advance(1 * MIN);
    createProgress('another-user', 3); // → cleanup() chạy

    assert.ok(getProgress('long-job'), 'phiên đang chạy phải còn nguyên');
    assert.equal(getProgress('long-job')?.completedFiles, 1300);
    updateProgress('long-job', { completedFiles: 1400 });
    assert.equal(getProgress('long-job')?.completedFiles, 1400, 'cập nhật sau đó không bị nuốt');
  });

  test('phiên đang xếp hàng/đang chạy nhưng im lặng QUÁ 6 giờ → coi là rò rỉ và dọn', (t) => {
    const clock = fakeClock(t);
    createProgress('ghost', 10, 'queued');
    clock.advance(6 * HOUR + MIN);
    createProgress('fresh', 1);
    assert.equal(getProgress('ghost'), undefined);
    assert.ok(getProgress('fresh'));
  });

  test('touchProgress giữ cho phiên đang truyền 1 file khổng lồ (chưa file nào xong) không bị dọn', (t) => {
    const clock = fakeClock(t);
    createProgress('huge-file', 1, 'running');
    for (let i = 0; i < 8; i++) {
      clock.advance(1 * HOUR);
      touchProgress('huge-file');
    }
    createProgress('other', 1);
    assert.ok(getProgress('huge-file'), '8 giờ liền vẫn sống nhờ touchProgress');
  });

  test('phiên ĐÃ XONG/LỖI được giữ ~30 phút kể từ lần cập nhật cuối rồi mới dọn', (t) => {
    const clock = fakeClock(t);
    createProgress('done-job', 2, 'running');
    createProgress('err-job', 2, 'running');
    finishProgress('done-job', 'done');
    finishProgress('err-job', 'error', 'boom');

    clock.advance(29 * MIN);
    createProgress('x1', 1);
    assert.ok(getProgress('done-job'), '29 phút: còn');
    assert.equal(getProgress('err-job')?.errorMessage, 'boom');

    clock.advance(2 * MIN);
    createProgress('x2', 1);
    assert.equal(getProgress('done-job'), undefined, '31 phút: đã dọn');
    assert.equal(getProgress('err-job'), undefined);
  });
});

describe('progress-store — updatedAt và trạng thái "listing"', () => {
  test('mọi thao tác ghi đều cập nhật updatedAt; startedAt giữ nguyên', (t) => {
    const clock = fakeClock(t);
    createProgress('t', 3, 'listing');
    const started = getProgress('t')!.startedAt;
    assert.equal(getProgress('t')?.status, 'listing');

    clock.advance(1000);
    updateProgress('t', { totalFiles: 4, status: 'queued' });
    assert.equal(getProgress('t')?.updatedAt, started + 1000);
    clock.advance(1000);
    addSkipped('t', 'a.txt', 'HTTP 403');
    assert.equal(getProgress('t')?.updatedAt, started + 2000);
    clock.advance(1000);
    finishProgress('t', 'done');
    assert.equal(getProgress('t')?.updatedAt, started + 3000);
    assert.equal(getProgress('t')?.startedAt, started);
    assert.equal(getProgress('t')?.skipped.length, 1);
  });

  test('token không tồn tại: các thao tác ghi là no-op, không ném lỗi', () => {
    assert.doesNotThrow(() => {
      updateProgress('nope', { completedFiles: 1 });
      addSkipped('nope', 'a', 'b');
      finishProgress('nope', 'done');
      touchProgress('nope');
    });
    assert.equal(getProgress('nope'), undefined);
  });
});

describe('isValidToken — token làm khoá Map phải gọn và an toàn', () => {
  test('chấp nhận token mà UI thật sinh ra (UUID, hoặc "<thời gian>-<ngẫu nhiên>")', () => {
    assert.equal(isValidToken('3f2504e0-4f89-41d3-9a0c-0305e82c3301'), true);
    assert.equal(isValidToken(`${Date.now()}-${Math.random().toString(36).slice(2)}`), true);
  });

  test('từ chối rỗng, quá ngắn, quá dài, ký tự lạ', () => {
    for (const bad of ['', 'abc', 'x'.repeat(101), 'a b c d e f g h', '../../etc/passwd', 'abc\ndef12345', 'tok<script>1234']) {
      assert.equal(isValidToken(bad), false, JSON.stringify(bad));
    }
  });
});

describe('progress-store — trần cứng số phiên (chống spam token)', () => {
  test('vượt 2000 phiên thì bỏ phiên ĐÃ XONG cũ nhất trước; phiên đang chạy được giữ', () => {
    createProgress('keep-running', 1, 'running');
    createProgress('old-finished', 1, 'running');
    finishProgress('old-finished', 'done');
    // Spam thật thường thất bại nhanh (link sai, 503...) nên kết thúc ở trạng thái "error".
    for (let i = 0; i < 2100; i++) {
      const t = `spam-${String(i).padStart(6, '0')}`;
      createProgress(t, 1, 'listing');
      finishProgress(t, 'error', 'x');
    }
    assert.ok(getProgress('keep-running'), 'phiên đang chạy không bị bỏ để nhường chỗ cho spam');
    assert.equal(getProgress('old-finished'), undefined, 'phiên đã xong cũ bị bỏ trước');
    let alive = 0;
    for (let i = 0; i < 2100; i++) if (getProgress(`spam-${String(i).padStart(6, '0')}`)) alive++;
    assert.ok(alive <= 2000, `còn ${alive} phiên spam — Map không được phình vô hạn`);
    assert.ok(getProgress('spam-002099'), 'phiên mới nhất vẫn còn');
  });

  test('dù TẤT CẢ đều đang chạy, Map vẫn không vượt trần (bỏ phiên cũ nhất)', () => {
    for (let i = 0; i < 2300; i++) createProgress(`live-${String(i).padStart(6, '0')}`, 1, 'running');
    let alive = 0;
    for (let i = 0; i < 2300; i++) if (getProgress(`live-${String(i).padStart(6, '0')}`)) alive++;
    assert.ok(alive <= 2000, `còn ${alive}`);
    assert.ok(getProgress('live-002299'));
  });
});
