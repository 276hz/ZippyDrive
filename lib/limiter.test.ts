import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { positiveIntEnv, createLimiter } from './limiter.ts';

describe('positiveIntEnv — không để giá trị hỏng lan ra hệ thống', () => {
  test('thiếu / rỗng / chữ / 0 / âm / Infinity / NaN → fallback', () => {
    for (const raw of [undefined, '', 'abc', '0', '-5', 'Infinity', 'NaN', ' ']) {
      assert.equal(positiveIntEnv(raw, 7), 7, JSON.stringify(raw));
    }
  });

  test('số hợp lệ → dùng đúng; số thập phân → làm tròn xuống', () => {
    assert.equal(positiveIntEnv('5', 7), 5);
    assert.equal(positiveIntEnv('2.9', 7), 2);
    assert.equal(positiveIntEnv('1', 7), 1);
  });
});

describe('createLimiter — hết chỗ thì từ chối ngay, không xếp hàng', () => {
  test('cho vào tới `max`, người thứ max+1 nhận null', () => {
    const lim = createLimiter(2);
    const a = lim.tryEnter();
    const b = lim.tryEnter();
    assert.ok(a && b);
    assert.equal(lim.tryEnter(), null);
    assert.equal(lim.active(), 2);
  });

  test('leave() trả lại chỗ; gọi leave() nhiều lần chỉ tính 1 lần (không đếm âm)', () => {
    const lim = createLimiter(1);
    const leave = lim.tryEnter()!;
    leave();
    leave();
    leave();
    assert.equal(lim.active(), 0);
    const again = lim.tryEnter();
    assert.ok(again, 'chỗ đã được trả');
    assert.equal(lim.tryEnter(), null, 'và vẫn chỉ có 1 chỗ — leave() thừa không tạo thêm chỗ ảo');
  });
});
