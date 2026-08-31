import type { BranchRange } from '@betterdb/shared';

export interface VersionMatch {
  vulnerable: boolean;
  fixedIn?: string;
}

const WILDCARD_BRANCH = '*';

function segments(version: string): number[] {
  return version.split('.').map((part) => {
    const numeric = parseInt(part, 10);
    return Number.isNaN(numeric) ? 0 : numeric;
  });
}

export function compareVersions(a: string, b: string): number {
  const left = segments(a);
  const right = segments(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

export function branchOf(version: string): string {
  return segments(version).slice(0, 2).join('.');
}

export function matchRanges(version: string, ranges: BranchRange[]): VersionMatch {
  const branch = branchOf(version);
  const onBranch = ranges.find((range) => {
    return range.branch === branch;
  });

  if (onBranch) {
    return {
      vulnerable: compareVersions(version, onBranch.vulnerableAtOrBelow) <= 0,
      ...(onBranch.patchedAt ? { fixedIn: onBranch.patchedAt } : {}),
    };
  }

  const wildcard = ranges.find((range) => {
    return range.branch === WILDCARD_BRANCH;
  });

  if (wildcard) {
    return {
      vulnerable: compareVersions(version, wildcard.vulnerableAtOrBelow) <= 0,
      ...(wildcard.patchedAt ? { fixedIn: wildcard.patchedAt } : {}),
    };
  }

  return { vulnerable: false };
}

export function parseModuleVersion(raw: number): string {
  const major = Math.floor(raw / 10000);
  const minor = Math.floor((raw % 10000) / 100);
  const patch = raw % 100;

  return `${major}.${minor}.${patch}`;
}
