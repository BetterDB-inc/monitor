import type { QueryPair } from '../types.js';
import { fetchDataset } from './loader.js';

const DATASET = 'google-research-datasets/paws';
const CONFIG = 'labeled_final';

export async function loadPawsWiki(options: {
  limit?: number;
}): Promise<QueryPair[]> {
  const rows = await fetchDataset(DATASET, 'test', options.limit, CONFIG);

  const pairs: QueryPair[] = [];
  for (const row of rows) {
    const label = Number(row.label);
    pairs.push({
      promptA: String(row.sentence1),
      promptB: String(row.sentence2),
      isSemanticMatch: label === 1,
      category: 'paws_wiki',
      source: 'paws_wiki',
    });
  }
  return pairs;
}
