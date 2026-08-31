import { matchAdvisories } from '../matcher/advisory-matcher';
import { parseModuleVersion } from '../matcher/version-range';
import {
  ALL_ADVISORIES,
  BLOOM_MODULE,
  UNVERSIONED,
  VALKEY_BRANCH_AWARE,
  VALKEY_KNOWN_EXPLOITED,
} from './fixtures/advisories';

const valkey809 = { product: 'valkey' as const, engineVersion: '8.0.9', modules: [] };

describe('matchAdvisories', () => {
  it('clears a patched maintenance release but flags the one before it', () => {
    const patched = matchAdvisories({ product: 'valkey', engineVersion: '8.0.10', modules: [] }, [
      VALKEY_BRANCH_AWARE,
    ]);
    const vulnerable = matchAdvisories(valkey809, [VALKEY_BRANCH_AWARE]);

    expect(patched.findings).toHaveLength(0);
    expect(vulnerable.findings).toHaveLength(1);
    expect(vulnerable.findings[0].fixedIn).toBe('8.0.10');
  });

  it('never applies a Redis range to a Valkey server', () => {
    const result = matchAdvisories(valkey809, ALL_ADVISORIES);
    const ids = result.findings.map((finding) => {
      return finding.advisory.cveId;
    });

    expect(ids).not.toContain('CVE-2022-0543');
  });

  it('matches a module CVE on the module version, not the engine version', () => {
    const result = matchAdvisories(
      { product: 'valkey', engineVersion: '9.1.1', modules: [{ name: 'bf', version: '1.0.2' }] },
      [BLOOM_MODULE],
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].matchedOn).toBe('module');
    expect(result.findings[0].moduleName).toBe('bf');
    expect(result.findings[0].matchedVersion).toBe('1.0.2');
  });

  it('does not match a module CVE when the module is not loaded', () => {
    const result = matchAdvisories({ product: 'valkey', engineVersion: '9.1.1', modules: [] }, [
      BLOOM_MODULE,
    ]);

    expect(result.findings).toHaveLength(0);
  });

  it('routes an unversioned advisory out of findings and out of the counts', () => {
    const result = matchAdvisories(valkey809, [VALKEY_BRANCH_AWARE, UNVERSIONED]);
    const counted = Object.values(result.severityCounts).reduce((sum, n) => {
      return sum + n;
    }, 0);

    expect(result.findings).toHaveLength(1);
    expect(result.unversioned).toEqual([UNVERSIONED]);
    expect(counted).toBe(1);
    expect(counted + result.unversioned.length).toBe(2);
  });

  it('ranks known-exploited first, then EPSS, never CVSS first', () => {
    const result = matchAdvisories(
      { product: 'valkey', engineVersion: '8.0.4', modules: [] },
      ALL_ADVISORIES,
    );
    const ids = result.findings.map((finding) => {
      return finding.advisory.cveId;
    });

    expect(ids[0]).toBe(VALKEY_KNOWN_EXPLOITED.cveId);
    expect(ids.indexOf('CVE-2026-63639')).toBeLessThan(ids.indexOf('CVE-2026-21863'));
  });
});

describe('parseModuleVersion', () => {
  it('expands the packed integer MODULE LIST reports', () => {
    expect(parseModuleVersion(10002)).toBe('1.0.2');
    expect(parseModuleVersion(20811)).toBe('2.8.11');
    expect(parseModuleVersion(999)).toBe('0.9.99');
  });
});
