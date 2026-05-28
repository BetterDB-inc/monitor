import type { CacheAdapter } from './adapters/base.js';
import type { QueryPair, ReplayResult } from './types.js';

export async function runReplay(
  adapter: CacheAdapter,
  pairs: QueryPair[],
  onProgress?: (phase: string, current: number, total: number) => void,
): Promise<ReplayResult[]> {
  await adapter.initialize();
  await adapter.clear();

  // Store phase: seed the cache with prompt_a → synthetic response
  for (let i = 0; i < pairs.length; i++) {
    await adapter.store(pairs[i].promptA, `Answer: ${pairs[i].promptA}`);
    onProgress?.('store', i + 1, pairs.length);
  }

  // Check phase: query with prompt_b, measure latency
  const results: ReplayResult[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const start = performance.now();
    const check = await adapter.check(pair.promptB);
    const latencyMs = performance.now() - start;

    results.push({
      promptA: pair.promptA,
      promptB: pair.promptB,
      isSemanticMatch: pair.isSemanticMatch,
      hit: check.hit,
      similarityScore: check.similarityScore,
      latencyMs,
      category: pair.category,
    });
    onProgress?.('check', i + 1, pairs.length);
  }

  return results;
}
