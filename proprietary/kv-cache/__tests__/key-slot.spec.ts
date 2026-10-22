import { keySlot, slotOwner } from '../key-slot';

describe('keySlot', () => {
  it.each([
    ['foo', 12182],
    ['bar', 5061],
    ['123456789', 12739],
    ['', 0],
  ])('hashes %p to slot %p', (key, slot) => {
    expect(keySlot(key)).toBe(slot);
  });

  it('hashes only the hash tag when one is present', () => {
    expect(keySlot('{user1000}.following')).toBe(keySlot('user1000'));
    expect(keySlot('foo{}{bar}')).not.toBe(keySlot('bar'));
    expect(keySlot('foo{{bar}}zap')).toBe(keySlot('{bar'));
  });
});

describe('slotOwner', () => {
  it('owns the slots inside its ranges, including single-slot ranges', () => {
    const owns = slotOwner([[0, 99], [500]]);
    expect([0, 99, 500].map(owns)).toEqual([true, true, true]);
    expect([100, 499, 501].map(owns)).toEqual([false, false, false]);
  });
});
