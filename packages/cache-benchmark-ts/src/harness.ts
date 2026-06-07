import type { CacheAdapter } from './adapters/base.js';
import type { QueryPair, ReplayResult } from './types.js';

export async function runReplay(
  adapter: CacheAdapter,
  pairs: QueryPair[],
  onProgress?: (phase: string, current: number, total: number) => void,
  storeMode: 'paired' | 'dense' = 'paired',
): Promise<ReplayResult[]> {
  await adapter.initialize();
  await adapter.clear();

  // Store phase
  if (storeMode === 'dense') {
    // Deduplicate: store every unique promptA exactly once.
    // This populates the cache with all prompts from all equivalence classes,
    // so the reranker has multiple entity-confusable neighbors to pick from.
    const seen = new Set<string>();
    const storeItems: Array<[string, string]> = [];
    for (const pair of pairs) {
      if (!seen.has(pair.promptA)) {
        seen.add(pair.promptA);
        storeItems.push([pair.promptA, 'The answer to your question is available in our knowledge base.']);
      }
    }
    for (let i = 0; i < storeItems.length; i++) {
      await adapter.store(storeItems[i][0], storeItems[i][1]);
      onProgress?.('store (dense)', i + 1, storeItems.length);
    }
  } else {
    for (let i = 0; i < pairs.length; i++) {
      await adapter.store(pairs[i].promptA, `Answer: ${pairs[i].promptA}`);
      onProgress?.('store', i + 1, pairs.length);
    }
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
