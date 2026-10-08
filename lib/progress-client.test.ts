import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { normalizeProgressMessage } from './progress-client.ts';

describe('normalizeProgressMessage — thông điệp SSE không bao giờ làm hỏng state', () => {
  test('BUG ĐÃ SỬA: {"status":"unknown"} (chưa có phiên) → null, để người gọi giữ nguyên trạng thái cũ', () => {
    assert.equal(normalizeProgressMessage({ status: 'unknown' }), null);
  });

  test('rác / sai kiểu → null, không ném', () => {
    for (const bad of [null, undefined, 42, 'x', [], {}, { status: 5 }, { status: 'weird' }, { skipped: [] }]) {
      assert.equal(normalizeProgressMessage(bad), null, JSON.stringify(bad));
    }
  });

  test('thông điệp đầy đủ từ server được giữ nguyên', () => {
    const msg = {
      totalFiles: 42,
      completedFiles: 5,
      currentFileName: 'a/b.pdf',
      skipped: [{ name: 'x.txt', reason: 'HTTP 403' }],
      status: 'running',
      startedAt: 1,
      updatedAt: 2,
    };
    assert.deepEqual(normalizeProgressMessage(msg), {
      totalFiles: 42,
      completedFiles: 5,
      currentFileName: 'a/b.pdf',
      skipped: [{ name: 'x.txt', reason: 'HTTP 403' }],
      status: 'running',
      queuePosition: undefined,
      queueLength: undefined,
      errorMessage: undefined,
    });
  });

  test('thiếu trường vẫn ra đối tượng đầy đủ: skipped luôn là mảng, số luôn là số', () => {
    const r = normalizeProgressMessage({ status: 'error', errorMessage: 'boom' })!;
    assert.deepEqual(r.skipped, []);
    assert.equal(r.totalFiles, 0);
    assert.equal(r.completedFiles, 0);
    assert.equal(r.currentFileName, null);
    assert.equal(r.errorMessage, 'boom');
    assert.doesNotThrow(() => r.skipped.length > 0); // đúng biểu thức mà UI đánh giá lúc render
  });

  test('nhận mọi trạng thái hợp lệ, kể cả "listing" (đang quét thư mục)', () => {
    for (const status of ['listing', 'queued', 'running', 'done', 'error']) {
      assert.equal(normalizeProgressMessage({ status })?.status, status);
    }
  });

  test('vị trí hàng đợi được chuyển tiếp; số không hợp lệ bị loại', () => {
    const r = normalizeProgressMessage({ status: 'queued', queuePosition: 2, queueLength: 5, totalFiles: 'abc', completedFiles: NaN })!;
    assert.equal(r.queuePosition, 2);
    assert.equal(r.queueLength, 5);
    assert.equal(r.totalFiles, 0);
    assert.equal(r.completedFiles, 0);
  });

  test('phần tử skipped sai dạng bị lọc bỏ thay vì làm vỡ UI', () => {
    const r = normalizeProgressMessage({ status: 'running', skipped: [{ name: 'ok', reason: 'r' }, null, 5, { name: 'no reason' }, { reason: 'no name' }] })!;
    assert.deepEqual(r.skipped, [{ name: 'ok', reason: 'r' }]);
  });
});
