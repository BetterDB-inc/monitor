import type { BranchRange } from '@betterdb/shared';

export function affectedRangeLabel(range: BranchRange): string | null {
  if (range.vulnerableBelow !== undefined) {
    if (range.vulnerableFrom === undefined) {
      return `< ${range.vulnerableBelow}`;
    }

    return `≥ ${range.vulnerableFrom}, < ${range.vulnerableBelow}`;
  }

  if (range.vulnerableAtOrBelow === undefined) {
    // An inferred wildcard with no ceiling is open-ended; any other range
    // without an upper bound has nothing to show.
    if (range.inferred === true && range.vulnerableFrom !== undefined) {
      return range.vulnerableFrom === '0.0.0' ? 'all versions' : `≥ ${range.vulnerableFrom}`;
    }

    return null;
  }

  if (range.vulnerableFrom === undefined) {
    return `≤ ${range.vulnerableAtOrBelow}`;
  }

  return `${range.vulnerableFrom} – ${range.vulnerableAtOrBelow}`;
}

export function affectedRangesLabel(ranges: BranchRange[]): string | null {
  const labels = ranges
    .map((entry) => {
      return affectedRangeLabel(entry);
    })
    .filter((label): label is string => {
      return label !== null;
    });

  if (labels.length === 0) {
    return null;
  }

  return labels.join(', ');
}
