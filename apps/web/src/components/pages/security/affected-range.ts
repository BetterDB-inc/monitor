import type { BranchRange } from '@betterdb/shared';

export function affectedRangeLabel(range: BranchRange): string {
  if (range.vulnerableFrom === undefined) {
    return `≤ ${range.vulnerableAtOrBelow}`;
  }

  return `${range.vulnerableFrom} – ${range.vulnerableAtOrBelow}`;
}

export function affectedRangesLabel(ranges: BranchRange[]): string | null {
  if (ranges.length === 0) {
    return null;
  }

  return ranges
    .map((entry) => {
      return affectedRangeLabel(entry);
    })
    .join(', ');
}
