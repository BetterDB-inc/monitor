// Bounded-concurrency map that preserves input order. Runs at most `limit`
// callbacks in flight at once; results[i] corresponds to items[i]. The first
// failure rejects the whole map AND stops the surviving workers from
// dispatching new calls — on a real run every extra dispatch is a paid LLM
// call, and runEval is a library entry point with no process.exit backstop.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const workerCount = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  let failed = false;

  async function worker(): Promise<void> {
    while (failed === false && next < items.length) {
      const index = next;
      next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}
