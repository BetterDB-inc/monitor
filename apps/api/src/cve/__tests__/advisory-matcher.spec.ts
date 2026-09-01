import { matchAdvisories } from '../matcher/advisory-matcher';
import { parseModuleVersion } from '../matcher/version-range';
import {
  ALL_ADVISORIES,
  BLOOM_MODULE,
  HIGH_EPSS_LOW_CVSS,
  LOW_EPSS_HIGH_CVSS,
  SEARCH_MODULE,
  UNVERSIONED,
  VALKEY_BRANCH_AWARE,
  VALKEY_KNOWN_EXPLOITED,
} from './fixtures/advisories';

const valkey809 = { product: 'valkey' as const, engineVersion: '8.0.9', modules: [] };

// Read off `MODULE LIST` on valkey/valkey-bundle:9.1-alpine, which builds
// valkey-search 1.2.1: 66049 === 0x010201.
const BUNDLE_SEARCH_VER = 66049;

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

  it('ranks a lower-CVSS advisory above a higher-CVSS one when its EPSS is higher', () => {
    const result = matchAdvisories({ product: 'valkey', engineVersion: '5.0.0', modules: [] }, [
      LOW_EPSS_HIGH_CVSS,
      HIGH_EPSS_LOW_CVSS,
    ]);
    const ids = result.findings.map((finding) => {
      return finding.advisory.cveId;
    });

    expect(ids[0]).toBe(HIGH_EPSS_LOW_CVSS.cveId);
    expect(ids[1]).toBe(LOW_EPSS_HIGH_CVSS.cveId);
  });
});

describe('matchAdvisories on a real valkey-bundle node', () => {
  it('flags a valkey-search advisory against the integer MODULE LIST reports', () => {
    const modules = [
      { name: 'search', version: parseModuleVersion('valkey', 'search', BUNDLE_SEARCH_VER) },
    ];
    const result = matchAdvisories({ product: 'valkey', engineVersion: '9.1.1', modules }, [
      SEARCH_MODULE,
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].matchedOn).toBe('module');
    expect(result.findings[0].moduleName).toBe('search');
    expect(result.findings[0].matchedVersion).toBe('1.2.1');
    expect(result.findings[0].fixedIn).toBe('1.2.2');
    expect(result.severityCounts.critical).toBe(1);
  });

  it('clears the same advisory once the module is patched', () => {
    const modules = [{ name: 'search', version: parseModuleVersion('valkey', 'search', 0x010202) }];
    const result = matchAdvisories({ product: 'valkey', engineVersion: '9.1.1', modules }, [
      SEARCH_MODULE,
    ]);

    expect(modules[0].version).toBe('1.2.2');
    expect(result.findings).toHaveLength(0);
    expect(result.unversioned).toEqual([]);
  });
});

describe('matchAdvisories with an undecodable module version', () => {
  it('reports the advisory as unversioned instead of clearing it', () => {
    const result = matchAdvisories(
      { product: 'valkey', engineVersion: '9.1.1', modules: [{ name: 'search', version: null }] },
      [SEARCH_MODULE],
    );

    expect(result.findings).toEqual([]);
    expect(result.unversioned).toEqual([SEARCH_MODULE]);
    expect(result.severityCounts.critical).toBe(0);
  });

  it('leaves advisories for other products untouched', () => {
    const result = matchAdvisories(
      {
        product: 'valkey',
        engineVersion: '8.0.9',
        modules: [{ name: 'search', version: null }],
      },
      [SEARCH_MODULE, VALKEY_BRANCH_AWARE],
    );
    const ids = result.findings.map((finding) => {
      return finding.advisory.cveId;
    });

    expect(ids).toEqual([VALKEY_BRANCH_AWARE.cveId]);
    expect(result.unversioned).toEqual([SEARCH_MODULE]);
  });
});
