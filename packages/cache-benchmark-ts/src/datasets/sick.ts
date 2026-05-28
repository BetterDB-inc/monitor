import type { QueryPair } from '../types.js';
import { fetchDataset } from './loader.js';

const DATASET = 'mteb/sickr-sts';
const MIN_SCORE = 1.0;
const MAX_SCORE = 5.0;

export async function loadSick(options: {
  limit?: number;
  matchThreshold?: number;
}): Promise<QueryPair[]> {
  const threshold = options.matchThreshold ?? 0.6;
  const rows = await fetchDataset(DATASET, 'test', options.limit);

  const pairs: QueryPair[] = [];
  for (const row of rows) {
    const score = Number(row.score);
    const normalized = (score - MIN_SCORE) / (MAX_SCORE - MIN_SCORE);
    if (!Number.isFinite(normalized)) continue;

    let category: string;
    if (score >= 4) category = 'high';
    else if (score >= 3) category = 'medium';
    else category = 'low';

    pairs.push({
      promptA: String(row.sentence1),
      promptB: String(row.sentence2),
      isSemanticMatch: normalized >= threshold,
      category,
      source: 'sick',
    });
  }
  return pairs;
}
