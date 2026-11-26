import { mapWithLimit } from '../bounded-map';

describe('mapWithLimit', () => {
  it('keeps the input order', async () => {
    const out = await mapWithLimit([30, 10, 20], 2, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms * 2;
    });
    expect(out).toEqual([60, 20, 40]);
  });

  it('never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    await mapWithLimit(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
    });
    expect(peak).toBe(3);
  });

  it('answers an empty list without calling the mapper', async () => {
    const each = jest.fn();
    expect(await mapWithLimit([], 4, each)).toEqual([]);
    expect(each).not.toHaveBeenCalled();
  });

  it('rejects with the first failure', async () => {
    await expect(
      mapWithLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('two');
        return n;
      }),
    ).rejects.toThrow('two');
  });
});
