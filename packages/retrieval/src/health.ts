export interface IndexHealthSnapshot {
  name: string;
  numDocs: number;
  indexingState: string;
  dims: number;
  percentIndexed: number;
  estimatedRecall: number | null;
}

export type RecallEstimator = (snapshot: Omit<IndexHealthSnapshot, 'estimatedRecall'>) => number;

const PERCENT_INDEXED_KEYS = ['percent_indexed', 'backfill_complete_percent'];

export function parsePercentIndexed(info: unknown[]): number {
  for (let i = 0; i < info.length - 1; i += 2) {
    if (!PERCENT_INDEXED_KEYS.includes(String(info[i]))) {
      continue;
    }
    const value = parseFloat(String(info[i + 1]));
    if (Number.isNaN(value)) {
      return 0;
    }
    // valkey-search/RediSearch report a 0-1 fraction; some versions report 0-100.
    return value <= 1 ? value * 100 : value;
  }
  return 0;
}
