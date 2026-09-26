import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { acquireSlot, release, currentActive, currentQueueLength, maxConcurrent, parseMaxConcurrent } from './download-lock.ts';

describe('parseMaxConcurrent — parse env an toàn, không lan truyền giá trị hỏng', () => {
  const ORIGINAL = process.env.MAX_CONCURRENT_DOWNLOADS;
  function withEnv<T>(value: string | undefined, fn: () => T): T {
    if (value === undefined) delete process.env.MAX_CONCURRENT_DOWNLOADS;
    else process.env.MAX_CONCURRENT_DOWNLOADS = value;
    try {
      return fn();
    } finally {
      if (ORIGINAL === undefined) delete process.env.MAX_CONCURRENT_DOWNLOADS;
      else process.env.MAX_CONCURRENT_DOWNLOADS = ORIGINAL;
    }
  }

  test('không set env -> mặc định 3', () => {
    withEnv(undefined, () => assert.equal(parseMaxConcurrent(), 3));
  });

  test('số hợp lệ -> dùng đúng số đó', () => {
    withEnv('5', () => assert.equal(parseMaxConcurrent(), 5));
  });

  test('BUG ĐÃ SỬA: chuỗi rác không được lan truyền thành NaN — Math.max(1, NaN) = NaN chứ KHÔNG PHẢI 1, khiến toàn bộ hàng đợi deadlock nếu không validate trước', () => {
    withEnv('abc-khong-phai-so', () => {
      const result = parseMaxConcurrent();
      assert.equal(Number.isNaN(result), false);
      assert.equal(result, 3);
    });
  });

  test('BUG ĐÃ SỬA: "Infinity" không được chấp nhận làm giới hạn thật (sẽ vô hiệu hoá concurrency limiter)', () => {
    withEnv('Infinity', () => {
      const result = parseMaxConcurrent();
      assert.equal(Number.isFinite(result), true);
      assert.equal(result, 3);
    });
  });

  test('số âm fallback về mặc định thay vì âm thầm chấp nhận', () => {
    withEnv('-5', () => assert.equal(parseMaxConcurrent(), 3));
  });

  test('số 0 fallback về mặc định', () => {
    withEnv('0', () => assert.equal(parseMaxConcurrent(), 3));
  });

  test('số thập phân được làm tròn xuống thành số nguyên', () => {
    withEnv('2.9', () => assert.equal(parseMaxConcurrent(), 2));
  });
});

describe('acquireSlot/release — bất biến hàng đợi (0 <= active <= MAX_CONCURRENT)', () => {
  // Mọi test dùng "room" tính TƯƠNG ĐỐI từ currentActive() lúc bắt đầu, không
  // giả định baseline tuyệt đối là 0 — an toàn dù chạy chung file với test khác.

  test('acquire trong giới hạn trả về ngay lập tức (fast path), release() trả lại đúng 1 slot', async () => {
    const before = currentActive();
    const result = await acquireSlot(null);
    assert.equal(result, 'acquired');
    assert.equal(currentActive(), before + 1);
    release();
    assert.equal(currentActive(), before);
  });

  test('vượt giới hạn thì bị xếp hàng, release() giải phóng đúng 1 slot cho người kế tiếp theo thứ tự FIFO', async () => {
    const limit = maxConcurrent();
    const room = Math.max(0, limit - currentActive());
    const fillers = await Promise.all(Array.from({ length: room }, () => acquireSlot(null)));
    assert.ok(fillers.every((r) => r === 'acquired'));
    assert.equal(currentActive(), limit, 'phải lấp đầy đúng bằng giới hạn hiện có');

    const order: number[] = [];
    const p1 = acquireSlot(null).then((r) => { order.push(1); return r; });
    const p2 = acquireSlot(null).then((r) => { order.push(2); return r; });
    const p3 = acquireSlot(null).then((r) => { order.push(3); return r; });

    // Nhường vòng lặp sự kiện một nhịp — cả 3 phải vẫn đang chờ, chưa resolve.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(order.length, 0, 'request vượt giới hạn phải chờ, không được cấp slot ngay');
    assert.ok(currentQueueLength() >= 3);

    // Giải phóng lần lượt 3 slot — phải cấp cho 1, 2, 3 ĐÚNG THỨ TỰ đó (FIFO).
    release();
    await p1;
    release();
    await p2;
    release();
    await p3;
    assert.deepEqual(order, [1, 2, 3]);
    assert.equal(currentActive(), limit, 'sau khi release+promote đúng số lần, active phải quay lại đúng giới hạn');

    // Dọn dẹp toàn bộ (room fillers ban đầu + 3 item vừa được promote = vẫn đang active).
    for (let i = 0; i < room; i++) release();
  });

  test('huỷ khi đang xếp hàng (chưa được cấp slot) KHÔNG làm tăng active — chưa từng chiếm tài nguyên nào', async () => {
    const limit = maxConcurrent();
    const room = Math.max(0, limit - currentActive());
    await Promise.all(Array.from({ length: room }, () => acquireSlot(null)));

    const beforeQueued = currentActive();
    const controller = new AbortController();
    const queuedPromise = acquireSlot(null, controller.signal);
    controller.abort();
    const result = await queuedPromise;

    assert.equal(result, 'aborted');
    assert.equal(currentActive(), beforeQueued, 'huỷ lúc còn xếp hàng không được làm active tăng lên');

    for (let i = 0; i < room; i++) release();
  });

  test('huỷ SAU KHI đã được cấp slot không tự ý giảm active (release() vẫn phải do phía gọi tự thực hiện)', async () => {
    const controller = new AbortController();
    const before = currentActive();
    const result = await acquireSlot(null, controller.signal);
    assert.equal(result, 'acquired');
    assert.equal(currentActive(), before + 1);

    // Abort SAU khi đã acquired — theo thiết kế, việc này không tự động release
    // (route gọi acquireSlot chịu trách nhiệm tự release qua signal RIÊNG của nó,
    // xem app/api/download/route.ts). acquireSlot's onAbort chỉ xử lý khi còn
    // trong hàng đợi (idx !== -1), sau khi acquired thì không làm gì thêm.
    controller.abort();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(currentActive(), before + 1, 'abort sau khi đã acquired không được tự ý giảm active');

    release();
    assert.equal(currentActive(), before);
  });
});
