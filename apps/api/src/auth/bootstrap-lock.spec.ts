import { BootstrapLock } from './bootstrap-lock';

describe('BootstrapLock', () => {
  it('runs tasks one at a time in arrival order', async () => {
    const lock = new BootstrapLock();
    const events: string[] = [];
    let releaseFirst: () => void = () => {
      return undefined;
    };
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = lock.run(async () => {
      events.push('first:start');
      await gate;
      events.push('first:end');
      return 1;
    });
    const second = lock.run(async () => {
      events.push('second:start');
      return 2;
    });
    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('still serves a later task after an earlier task rejected', async () => {
    const lock = new BootstrapLock();
    const failed = lock.run(async () => {
      throw new Error('boom');
    });
    const later = lock.run(async () => {
      return 'served';
    });
    await expect(failed).rejects.toThrow('boom');
    await expect(later).resolves.toBe('served');
  });
});
