import type { BranchRange, CveProduct } from '@betterdb/shared';
import type { ModuleVersionEncoding } from '../cve.constants';
import { MODULE_VERSION_ENCODINGS } from '../cve.constants';

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

function matchRange(version: string, range: BranchRange): VersionMatch {
  const aboveLowerBound =
    range.vulnerableFrom === undefined || compareVersions(version, range.vulnerableFrom) >= 0;
  const belowUpperBound = compareVersions(version, range.vulnerableAtOrBelow) <= 0;

  return {
    vulnerable: aboveLowerBound && belowUpperBound,
    ...(range.patchedAt ? { fixedIn: range.patchedAt } : {}),
  };
}

export function matchRanges(version: string, ranges: BranchRange[]): VersionMatch {
  const branch = branchOf(version);
  const onBranch = ranges.find((range) => {
    return range.branch === branch;
  });
  const wildcard = ranges.find((range) => {
    return range.branch === WILDCARD_BRANCH;
  });

  if (onBranch) {
    const match = matchRange(version, onBranch);
    if (match.vulnerable === true) {
      return match;
    }
  }

  if (wildcard) {
    const match = matchRange(version, wildcard);
    if (match.vulnerable === true) {
      return match;
    }
  }

  if (onBranch) {
    return { vulnerable: false, ...(onBranch.patchedAt ? { fixedIn: onBranch.patchedAt } : {}) };
  }

  if (wildcard) {
    return { vulnerable: false, ...(wildcard.patchedAt ? { fixedIn: wildcard.patchedAt } : {}) };
  }

  return { vulnerable: false };
}

const MAX_ENCODED_VERSION = 0xffffffff;

function decodeDecimal(raw: number): string {
  const major = Math.floor(raw / 10000);
  const minor = Math.floor((raw % 10000) / 100);
  const patch = raw % 100;

  return `${major}.${minor}.${patch}`;
}

function decodeByteTriplet(raw: number): string {
  const major = Math.floor(raw / 0x10000);
  const minor = Math.floor(raw / 0x100) % 0x100;
  const patch = raw % 0x100;

  return `${major}.${minor}.${patch}`;
}

function decodeByteQuadStage(raw: number): string {
  const major = Math.floor(raw / 0x1000000) % 0x100;
  const minor = Math.floor(raw / 0x10000) % 0x100;
  const patch = Math.floor(raw / 0x100) % 0x100;

  return `${major}.${minor}.${patch}`;
}

function decodeWith(encoding: ModuleVersionEncoding, raw: number): string {
  if (encoding === 'decimal') {
    return decodeDecimal(raw);
  }

  if (encoding === 'byte-triplet') {
    return decodeByteTriplet(raw);
  }

  return decodeByteQuadStage(raw);
}

export function moduleVersionEncoding(
  product: CveProduct,
  name: string,
): ModuleVersionEncoding | undefined {
  const table = MODULE_VERSION_ENCODINGS[product];
  if (table === undefined) {
    return undefined;
  }

  return table[name.toLowerCase()];
}

export function parseModuleVersion(product: CveProduct, name: string, raw: number): string | null {
  const encoding = moduleVersionEncoding(product, name);
  if (encoding === undefined) {
    return null;
  }

  if (Number.isInteger(raw) === false || raw < 0 || raw > MAX_ENCODED_VERSION) {
    return null;
  }

  return decodeWith(encoding, raw);
}
