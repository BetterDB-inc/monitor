/** Race a promise against a timeout, clearing the timer on settle. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message = 'Timed out'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
