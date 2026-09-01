import type { BranchRange, CveProduct } from '@betterdb/shared';
import { MODULE_PRODUCTS } from '@betterdb/shared';
import {
  branchOf,
  compareVersions,
  matchRanges,
  moduleVersionEncoding,
  parseModuleVersion,
} from '../matcher/version-range';

// GHSA-jqcm-9gh4-2vgv / CVE-2026-63639, captured 2026-08-31
const CVE_2026_63639: BranchRange[] = [
  { branch: '9.1', vulnerableAtOrBelow: '9.1.0', patchedAt: '9.1.1' },
  { branch: '9.0', vulnerableAtOrBelow: '9.0.4', patchedAt: '9.0.5' },
  { branch: '8.1', vulnerableAtOrBelow: '8.1.8', patchedAt: '8.1.9' },
  { branch: '8.0', vulnerableAtOrBelow: '8.0.9', patchedAt: '8.0.10' },
  { branch: '7.2', vulnerableAtOrBelow: '7.2.13', patchedAt: '7.2.14' },
];

const NVD_ONLY: BranchRange[] = [{ branch: '*', vulnerableAtOrBelow: '9.1.0' }];

describe('compareVersions', () => {
  it('orders by numeric segment, not lexically', () => {
    expect(compareVersions('8.0.10', '8.0.9')).toBeGreaterThan(0);
    expect(compareVersions('8.0.9', '8.0.10')).toBeLessThan(0);
    expect(compareVersions('8.0.9', '8.0.9')).toBe(0);
  });

  it('treats a missing segment as zero', () => {
    expect(compareVersions('8.0', '8.0.0')).toBe(0);
    expect(compareVersions('8.1', '8.0.9')).toBeGreaterThan(0);
  });
});

describe('branchOf', () => {
  it('takes the first two segments', () => {
    expect(branchOf('8.0.9')).toBe('8.0');
    expect(branchOf('9.1.1')).toBe('9.1');
  });
});

describe('matchRanges', () => {
  it('clears a patched maintenance release', () => {
    expect(matchRanges('8.0.10', CVE_2026_63639)).toEqual({ vulnerable: false, fixedIn: '8.0.10' });
  });

  it('flags the last vulnerable release on the same branch', () => {
    expect(matchRanges('8.0.9', CVE_2026_63639)).toEqual({ vulnerable: true, fixedIn: '8.0.10' });
  });

  it('does not apply another branch range to an unlisted branch', () => {
    expect(matchRanges('6.2.14', CVE_2026_63639)).toEqual({ vulnerable: false });
  });

  it('falls back to a wildcard range when no branch matches', () => {
    expect(matchRanges('8.0.10', NVD_ONLY)).toEqual({ vulnerable: true });
  });

  it('reports not vulnerable for an empty range list', () => {
    expect(matchRanges('8.0.9', [])).toEqual({ vulnerable: false });
  });

  it('clears a release below the range lower bound', () => {
    const lowerBounded: BranchRange[] = [
      { branch: '7.2', vulnerableAtOrBelow: '7.2.8', vulnerableFrom: '7.2.4' },
    ];

    expect(matchRanges('7.2.3', lowerBounded).vulnerable).toBe(false);
    expect(matchRanges('7.2.4', lowerBounded).vulnerable).toBe(true);
    expect(matchRanges('7.2.8', lowerBounded).vulnerable).toBe(true);
    expect(matchRanges('7.2.9', lowerBounded).vulnerable).toBe(false);
  });

  it('treats a range with no lower bound as vulnerable all the way down', () => {
    const openBelow: BranchRange[] = [{ branch: '7.2', vulnerableAtOrBelow: '7.2.8' }];

    expect(matchRanges('7.0.0', openBelow).vulnerable).toBe(false);
    expect(matchRanges('7.2.0', openBelow).vulnerable).toBe(true);
  });

  it('still consults the wildcard range when the branch range excludes the version', () => {
    const mixed: BranchRange[] = [
      { branch: '8.0', vulnerableAtOrBelow: '8.0.9', vulnerableFrom: '8.0.5' },
      { branch: '*', vulnerableAtOrBelow: '9.9.9' },
    ];

    expect(matchRanges('8.0.1', mixed).vulnerable).toBe(true);
    expect(matchRanges('8.0.7', mixed).vulnerable).toBe(true);
  });
});

// Every integer below was read off a live engine with `MODULE LIST` on 2026-09-01
// and cross-checked against the module version each project's source encodes:
//
//   valkey/valkey-bundle:9.1-alpine (built from valkey-json 1.0.2, valkey-bloom
//   1.0.1, valkey-search 1.2.1, valkey-ldap 1.1.1):
//     json 10002, bf 10001, search 66049, ldap 16843263
//   redis:8-alpine reporting redis_version 8.6.2:
//     search 80600, bf 80600, ReJSON 80600, timeseries 80600
describe('parseModuleVersion', () => {
  it('decodes the decimal modules valkey-bundle reports', () => {
    expect(parseModuleVersion('valkey', 'json', 10002)).toBe('1.0.2');
    expect(parseModuleVersion('valkey', 'bf', 10001)).toBe('1.0.1');
  });

  it('decodes valkey-search as packed bytes, not as decimal digits', () => {
    expect(parseModuleVersion('valkey', 'search', 66049)).toBe('1.2.1');
  });

  it('decodes valkey-ldap as packed bytes and drops the release-stage byte', () => {
    expect(parseModuleVersion('valkey', 'ldap', 16843263)).toBe('1.1.1');
    expect(parseModuleVersion('valkey', 'ldap', 0x01010102)).toBe('1.1.1');
  });

  it('decodes the decimal modules redis 8 bundles', () => {
    expect(parseModuleVersion('redis', 'search', 80600)).toBe('8.6.0');
    expect(parseModuleVersion('redis', 'timeseries', 80600)).toBe('8.6.0');
  });

  it('looks the encoding up case-insensitively', () => {
    expect(parseModuleVersion('redis', 'ReJSON', 80600)).toBe('8.6.0');
  });

  it('keys the encoding on the module, not on the integer', () => {
    expect(parseModuleVersion('valkey', 'search', 66049)).toBe('1.2.1');
    expect(parseModuleVersion('redis', 'search', 66049)).toBe('6.60.49');
    expect(parseModuleVersion('valkey', 'search', 80600)).toBe('1.58.216');
    expect(parseModuleVersion('redis', 'search', 80600)).toBe('8.6.0');
  });

  it('returns null for a module with no declared encoding', () => {
    expect(parseModuleVersion('valkey', 'lua', 1)).toBeNull();
    expect(parseModuleVersion('redis', 'vectorset', 1)).toBeNull();
    expect(parseModuleVersion('valkey', 'timeseries', 80600)).toBeNull();
    expect(parseModuleVersion('valkey-search', 'search', 66049)).toBeNull();
  });

  it('returns null for an integer that cannot be a packed version', () => {
    expect(parseModuleVersion('valkey', 'search', -1)).toBeNull();
    expect(parseModuleVersion('valkey', 'search', 1.5)).toBeNull();
    expect(parseModuleVersion('valkey', 'search', 2 ** 33)).toBeNull();
    expect(parseModuleVersion('valkey', 'search', Number.NaN)).toBeNull();
  });
});

describe('moduleVersionEncoding', () => {
  it('declares an encoding for every module mapped to a CVE product', () => {
    const missing: string[] = [];

    for (const [product, table] of Object.entries(MODULE_PRODUCTS)) {
      for (const name of Object.keys(table)) {
        if (moduleVersionEncoding(product as CveProduct, name) === undefined) {
          missing.push(`${product}/${name}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
