import { withTimeout } from '../with-timeout';

describe('withTimeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves with the inner value when it settles before the timeout', async () => {
    const pending = withTimeout(Promise.resolve('ok'), 1000);
    await expect(pending).resolves.toBe('ok');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects with the inner error when it rejects before the timeout', async () => {
    const pending = withTimeout(Promise.reject(new Error('inner boom')), 1000);
    await expect(pending).rejects.toThrow('inner boom');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects with the default message when the promise hangs', async () => {
    const pending = withTimeout(new Promise(() => undefined), 1000);
    const assertion = expect(pending).rejects.toThrow('Timed out');
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects with a custom message when the promise hangs', async () => {
    const pending = withTimeout(new Promise(() => undefined), 5000, 'Probe timed out after 5000ms');
    const assertion = expect(pending).rejects.toThrow('Probe timed out after 5000ms');
    await jest.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ignores a late rejection after the timeout fired without an unhandled rejection', async () => {
    let rejectLate!: (err: Error) => void;
    const inner = new Promise<never>((_, reject) => {
      rejectLate = reject;
    });

    const pending = withTimeout(inner, 100, 'custom msg');
    const outcome = pending.then(
      () => 'fulfilled',
      (err: Error) => err.message,
    );
    await jest.advanceTimersByTimeAsync(100);
    await expect(pending).rejects.toThrow('custom msg');
    expect(jest.getTimerCount()).toBe(0);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      jest.useRealTimers();
      rejectLate(new Error('late failure'));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
      await expect(outcome).resolves.toBe('custom msg');
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('ignores a late resolution after the timeout fired', async () => {
    let resolveLate!: (value: string) => void;
    const inner = new Promise<string>((resolve) => {
      resolveLate = resolve;
    });

    const pending = withTimeout(inner, 100);
    const outcome = pending.then(
      () => 'fulfilled',
      (err: Error) => err.message,
    );
    await jest.advanceTimersByTimeAsync(100);
    await expect(pending).rejects.toThrow('Timed out');
    expect(jest.getTimerCount()).toBe(0);

    resolveLate('too late');
    await Promise.resolve();
    await expect(outcome).resolves.toBe('Timed out');
    expect(jest.getTimerCount()).toBe(0);
  });
});
