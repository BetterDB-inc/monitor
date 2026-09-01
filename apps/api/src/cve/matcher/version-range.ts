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

function belowUpperBoundOf(version: string, range: BranchRange): boolean {
  if (range.vulnerableBelow !== undefined) {
    return compareVersions(version, range.vulnerableBelow) < 0;
  }

  if (range.vulnerableAtOrBelow !== undefined) {
    return compareVersions(version, range.vulnerableAtOrBelow) <= 0;
  }

  return false;
}

function matchRange(version: string, range: BranchRange): VersionMatch {
  const aboveLowerBound =
    range.vulnerableFrom === undefined || compareVersions(version, range.vulnerableFrom) >= 0;

  return {
    vulnerable: aboveLowerBound && belowUpperBoundOf(version, range),
    ...(range.patchedAt ? { fixedIn: range.patchedAt } : {}),
  };
}

function firstVulnerable(version: string, ranges: BranchRange[]): VersionMatch | null {
  for (const range of ranges) {
    const match = matchRange(version, range);
    if (match.vulnerable === true) {
      return match;
    }
  }

  return null;
}

function lowestPatchedAt(ranges: BranchRange[]): string | undefined {
  const patched = ranges
    .map((range) => {
      return range.patchedAt;
    })
    .filter((value): value is string => {
      return value !== undefined;
    });

  if (patched.length === 0) {
    return undefined;
  }

  return patched.reduce((lowest, candidate) => {
    return compareVersions(candidate, lowest) < 0 ? candidate : lowest;
  });
}

export function matchRanges(version: string, ranges: BranchRange[]): VersionMatch {
  const branch = branchOf(version);
  const onBranch = ranges.filter((range) => {
    return range.branch === branch;
  });
  const wildcard = ranges.filter((range) => {
    return range.branch === WILDCARD_BRANCH;
  });

  const vulnerable = firstVulnerable(version, onBranch) ?? firstVulnerable(version, wildcard);
  if (vulnerable !== null) {
    return vulnerable;
  }

  const fixedIn = lowestPatchedAt(onBranch) ?? lowestPatchedAt(wildcard);

  return { vulnerable: false, ...(fixedIn ? { fixedIn } : {}) };
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
