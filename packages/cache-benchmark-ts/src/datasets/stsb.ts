import type { QueryPair } from '../types.js';
import { fetchDataset } from './loader.js';

const DATASET = 'mteb/stsbenchmark-sts';
const MAX_SCORE = 5.0;

const SPLITS = ['train', 'validation', 'test'];

export async function loadStsb(options: {
  limit?: number;
  matchThreshold?: number;
}): Promise<QueryPair[]> {
  const threshold = options.matchThreshold ?? 0.6;

  // Load all splits and concatenate, matching the Python harness (8,628 pairs total)
  const allRows = [];
  for (const split of SPLITS) {
    const rows = await fetchDataset(DATASET, split);
    allRows.push(...rows);
  }
  const rows = options.limit ? allRows.slice(0, options.limit) : allRows;

  const pairs: QueryPair[] = [];
  for (const row of rows) {
    const score = Number(row.score);
    const normalized = score / MAX_SCORE;
    if (!Number.isFinite(normalized)) continue;

    pairs.push({
      promptA: String(row.sentence1),
      promptB: String(row.sentence2),
      isSemanticMatch: normalized >= threshold,
      category: typeof row.genre === 'string' ? row.genre : undefined,
      source: 'stsb',
    });
  }
  return pairs;
}
