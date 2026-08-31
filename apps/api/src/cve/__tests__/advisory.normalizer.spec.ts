import type { Advisory } from '@betterdb/shared';
import { computeDatasetVersion, normalizeAdvisories } from '../normalize/advisory.normalizer';
import type { EnrichmentResult, SourceFetchResult } from '../sources/cve-source.interface';
import { NvdSource } from '../sources/nvd.source';
import nvdValkey from './fixtures/nvd-valkey.json';

const GHSA_VIEW: Advisory = {
  cveId: 'CVE-2026-63639',
  aliases: ['GHSA-jqcm-9gh4-2vgv'],
  product: 'valkey',
  affected: [{ branch: '8.0', vulnerableAtOrBelow: '8.0.9', patchedAt: '8.0.10' }],
  severity: 'high',
  cvssScore: 8.8,
  cwes: ['CWE-122'],
  knownExploited: false,
  confidence: 'exact',
  sources: [{ source: 'ghsa', fields: ['affected'] }],
  summary: 'Heap overflow in the Valkey server',
  references: ['https://github.com/valkey-io/valkey/security/advisories/GHSA-jqcm-9gh4-2vgv'],
};

const NVD_VIEW: Advisory = {
  cveId: 'CVE-2026-63639',
  aliases: [],
  product: 'valkey',
  affected: [{ branch: '*', vulnerableAtOrBelow: '9.1.1-0' }],
  severity: 'high',
  cvssScore: 8.8,
  cwes: [],
  knownExploited: false,
  confidence: 'broad',
  sources: [{ source: 'nvd', fields: ['affected'] }],
  summary: 'Heap overflow',
  references: ['https://nvd.nist.gov/vuln/detail/CVE-2026-63639'],
};

function fetched(source: 'ghsa' | 'nvd' | 'mitre', advisories: Advisory[]): SourceFetchResult {
  return { source, advisories, recordCount: advisories.length, query: source, fetchedAt: 1 };
}

function fetchStub(body: unknown): jest.Mock {
  return jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
}

describe('normalizeAdvisories', () => {
  it('lets the GHSA range win over the NVD range for the same CVE', () => {
    const { advisories } = normalizeAdvisories(
      [fetched('nvd', [NVD_VIEW]), fetched('ghsa', [GHSA_VIEW])],
      [],
    );

    expect(advisories).toHaveLength(1);
    expect(advisories[0].affected).toEqual(GHSA_VIEW.affected);
    expect(advisories[0].confidence).toBe('exact');
  });

  it('keeps the NVD range when GHSA has no opinion', () => {
    const { advisories } = normalizeAdvisories([fetched('nvd', [NVD_VIEW])], []);

    expect(advisories[0].confidence).toBe('broad');
    expect(advisories[0].affected[0].branch).toBe('*');
  });

  it('unions aliases, cwes and references across sources', () => {
    const { advisories } = normalizeAdvisories(
      [fetched('ghsa', [GHSA_VIEW]), fetched('nvd', [NVD_VIEW])],
      [],
    );

    expect(advisories[0].aliases).toEqual(['GHSA-jqcm-9gh4-2vgv']);
    expect(advisories[0].cwes).toEqual(['CWE-122']);
    expect(advisories[0].references).toHaveLength(2);
  });

  it('records provenance from every contributing source', () => {
    const { advisories } = normalizeAdvisories(
      [fetched('ghsa', [GHSA_VIEW]), fetched('nvd', [NVD_VIEW])],
      [],
    );
    const sources = advisories[0].sources.map((entry) => {
      return entry.source;
    });

    expect(sources).toEqual(expect.arrayContaining(['ghsa', 'nvd']));
  });

  it('applies KEV and EPSS enrichment without touching the ranges', () => {
    const enrichment: EnrichmentResult[] = [
      {
        source: 'kev',
        entries: [['CVE-2026-63639', { knownExploited: true }]],
        recordCount: 1,
        query: 'kev',
        fetchedAt: 1,
      },
      {
        source: 'epss',
        entries: [['CVE-2026-63639', { epssScore: 0.01, epssPercentile: 0.78 }]],
        recordCount: 1,
        query: 'epss',
        fetchedAt: 1,
      },
    ];
    const { advisories } = normalizeAdvisories([fetched('ghsa', [GHSA_VIEW])], enrichment);

    expect(advisories[0].knownExploited).toBe(true);
    expect(advisories[0].epssScore).toBe(0.01);
    expect(advisories[0].affected).toEqual(GHSA_VIEW.affected);
  });
});

describe('computeDatasetVersion', () => {
  it('is stable across input order', () => {
    const a = computeDatasetVersion([GHSA_VIEW, { ...NVD_VIEW, cveId: 'CVE-2000-0001' }]);
    const b = computeDatasetVersion([{ ...NVD_VIEW, cveId: 'CVE-2000-0001' }, GHSA_VIEW]);

    expect(a).toBe(b);
  });

  it('changes when a range changes', () => {
    const before = computeDatasetVersion([GHSA_VIEW]);
    const after = computeDatasetVersion([
      {
        ...GHSA_VIEW,
        affected: [{ branch: '8.0', vulnerableAtOrBelow: '8.0.10', patchedAt: '8.0.11' }],
      },
    ]);

    expect(before).not.toBe(after);
  });
});

// Q5 guard: both source families emit one advisory per product for the same CVE.
// Keying the merge on cveId alone kept whichever product Map order yielded and dropped
// the other product's ranges, hiding a live CVE from every node of that product.
describe('normalizeAdvisories — one CVE affecting two products', () => {
  it('keeps CVE-2025-21605 as both a redis and a valkey advisory with their own ranges', async () => {
    const result = await new NvdSource(fetchStub(nvdValkey)).fetchAdvisories();
    const { advisories } = normalizeAdvisories([result], []);
    const rows = advisories.filter((advisory) => {
      return advisory.cveId === 'CVE-2025-21605';
    });
    const redis = rows.find((advisory) => {
      return advisory.product === 'redis';
    });
    const valkey = rows.find((advisory) => {
      return advisory.product === 'valkey';
    });

    expect(redis).toBeDefined();
    expect(valkey).toBeDefined();
    expect(redis?.affected).toHaveLength(2);
    expect(redis?.affected).toContainEqual({ branch: '*', vulnerableAtOrBelow: '7.2.7' });
    expect(redis?.affected).toContainEqual({ branch: '7.4', vulnerableAtOrBelow: '7.4.2' });
    expect(valkey?.affected).toHaveLength(3);
    expect(valkey?.affected).toContainEqual({ branch: '7.2', vulnerableAtOrBelow: '7.2.8' });
    expect(valkey?.affected).toContainEqual({ branch: '8.0', vulnerableAtOrBelow: '8.0.2' });
    expect(valkey?.affected).toContainEqual({ branch: '8.1', vulnerableAtOrBelow: '8.1.0' });
    expect(redis?.affected).not.toContainEqual({ branch: '8.0', vulnerableAtOrBelow: '8.0.2' });
  });

  it('merges the same product across sources but never merges across products', () => {
    const redisView: Advisory = { ...GHSA_VIEW, product: 'redis' };
    const { advisories } = normalizeAdvisories(
      [fetched('ghsa', [GHSA_VIEW, redisView]), fetched('nvd', [NVD_VIEW])],
      [],
    );

    expect(advisories).toHaveLength(2);
    expect(
      advisories.map((advisory) => {
        return advisory.product;
      }),
    ).toEqual(expect.arrayContaining(['valkey', 'redis']));
  });
});

// Q2 guard: the range winner's missing optional fields must not blank a value a
// lower-precedence source supplied. severity stays winner-only by ruling.
describe('normalizeAdvisories — field-level fallback', () => {
  const GHSA_UNSCORED: Advisory = {
    cveId: 'CVE-2026-70001',
    aliases: ['GHSA-unscored'],
    product: 'valkey',
    affected: [{ branch: '8.0', vulnerableAtOrBelow: '8.0.9', patchedAt: '8.0.10' }],
    severity: 'medium',
    cwes: [],
    knownExploited: false,
    confidence: 'exact',
    sources: [{ source: 'ghsa', fields: ['affected'] }],
    summary: '',
    references: ['https://ghsa.example/CVE-2026-70001'],
  };
  const NVD_SCORED: Advisory = {
    cveId: 'CVE-2026-70001',
    aliases: [],
    product: 'valkey',
    affected: [{ branch: '*', vulnerableAtOrBelow: '9.1.0' }],
    severity: 'critical',
    cvssScore: 9.8,
    cwes: ['CWE-122'],
    knownExploited: false,
    confidence: 'broad',
    sources: [{ source: 'nvd', fields: ['affected'] }],
    summary: 'Use after free in the server',
    references: ['https://nvd.example/CVE-2026-70001'],
  };

  it('inherits cvssScore, cwes and summary from NVD when the GHSA winner lacks them', () => {
    const { advisories } = normalizeAdvisories(
      [fetched('ghsa', [GHSA_UNSCORED]), fetched('nvd', [NVD_SCORED])],
      [],
    );

    expect(advisories[0].cvssScore).toBe(9.8);
    expect(advisories[0].cwes).toEqual(['CWE-122']);
    expect(advisories[0].summary).toBe('Use after free in the server');
    expect(advisories[0].affected).toEqual(GHSA_UNSCORED.affected);
    expect(advisories[0].confidence).toBe('exact');
  });

  it('keeps severity from the range winner, a known limitation of the medium default', () => {
    const { advisories } = normalizeAdvisories(
      [fetched('ghsa', [GHSA_UNSCORED]), fetched('nvd', [NVD_SCORED])],
      [],
    );

    expect(advisories[0].severity).toBe('medium');
  });

  it('takes the NVD ranges when the GHSA view is unversioned, and says so', () => {
    const unversioned: Advisory = { ...GHSA_VIEW, affected: [], confidence: 'unversioned' };
    const { advisories } = normalizeAdvisories(
      [fetched('ghsa', [unversioned]), fetched('nvd', [NVD_VIEW])],
      [],
    );
    const nvd = advisories[0].sources.find((entry) => {
      return entry.source === 'nvd';
    });

    expect(advisories[0].affected).toEqual(NVD_VIEW.affected);
    expect(advisories[0].confidence).toBe('broad');
    expect(nvd?.fields).toContain('affected');
  });

  it('keeps an advisory no source could version instead of dropping it', () => {
    const unversioned: Advisory = { ...GHSA_VIEW, affected: [], confidence: 'unversioned' };
    const { advisories } = normalizeAdvisories([fetched('ghsa', [unversioned])], []);

    expect(advisories).toHaveLength(1);
    expect(advisories[0].confidence).toBe('unversioned');
    expect(advisories[0].affected).toEqual([]);
  });
});

// Q3 guard: sources exists so the UI can say which source supplied which field.
// Crediting NVD with `affected` after GHSA won the ranges is a falsehood on screen.
describe('normalizeAdvisories — provenance honesty', () => {
  it('credits GHSA and not NVD for the ranges GHSA won', () => {
    const { advisories } = normalizeAdvisories(
      [fetched('nvd', [NVD_VIEW]), fetched('ghsa', [GHSA_VIEW])],
      [],
    );
    const ghsa = advisories[0].sources.find((entry) => {
      return entry.source === 'ghsa';
    });
    const nvd = advisories[0].sources.find((entry) => {
      return entry.source === 'nvd';
    });

    expect(ghsa?.fields).toContain('affected');
    expect(nvd?.fields).not.toContain('affected');
    expect(nvd?.fields).toContain('references');
  });

  it('credits KEV and EPSS for the fields they actually supplied', () => {
    const enrichment: EnrichmentResult[] = [
      {
        source: 'kev',
        entries: [['CVE-2026-63639', { knownExploited: true }]],
        recordCount: 1,
        query: 'kev',
        fetchedAt: 1,
      },
      {
        source: 'epss',
        entries: [['CVE-2026-63639', { epssScore: 0.01, epssPercentile: 0.78 }]],
        recordCount: 1,
        query: 'epss',
        fetchedAt: 1,
      },
    ];
    const { advisories } = normalizeAdvisories([fetched('ghsa', [GHSA_VIEW])], enrichment);
    const kev = advisories[0].sources.find((entry) => {
      return entry.source === 'kev';
    });
    const epss = advisories[0].sources.find((entry) => {
      return entry.source === 'epss';
    });

    expect(kev?.fields).toEqual(['knownExploited']);
    expect(epss?.fields).toEqual(['epssScore', 'epssPercentile']);
  });
});

// Q4 guard: the canonical form must not inherit source-arrival order, or an upstream
// reshuffle churns the dataset version and forces a pointless rescan of every node.
describe('computeDatasetVersion — canonical ordering', () => {
  const MULTI: Advisory = {
    ...GHSA_VIEW,
    affected: [
      { branch: '7.2', vulnerableAtOrBelow: '7.2.13', patchedAt: '7.2.14' },
      { branch: '8.0', vulnerableAtOrBelow: '8.0.9', patchedAt: '8.0.10' },
      { branch: '9.0', vulnerableAtOrBelow: '9.0.4', patchedAt: '9.0.5' },
    ],
  };

  it('is unchanged when a source returns the same ranges in a different order', () => {
    const forward = computeDatasetVersion([MULTI]);
    const reversed = computeDatasetVersion([{ ...MULTI, affected: [...MULTI.affected].reverse() }]);

    expect(forward).toBe(reversed);
  });

  it('is unchanged when aliases, cwes, references and sources arrive in a different order', () => {
    const forward = computeDatasetVersion([
      {
        ...MULTI,
        aliases: ['GHSA-a', 'GHSA-b'],
        cwes: ['CWE-122', 'CWE-787'],
        references: ['https://a', 'https://b'],
        sources: [
          { source: 'ghsa', fields: ['affected', 'severity'] },
          { source: 'nvd', fields: ['references'] },
        ],
      },
    ]);
    const shuffled = computeDatasetVersion([
      {
        ...MULTI,
        aliases: ['GHSA-b', 'GHSA-a'],
        cwes: ['CWE-787', 'CWE-122'],
        references: ['https://b', 'https://a'],
        sources: [
          { source: 'nvd', fields: ['references'] },
          { source: 'ghsa', fields: ['severity', 'affected'] },
        ],
      },
    ]);

    expect(forward).toBe(shuffled);
  });

  it('is stable across input order for two products of the same CVE', () => {
    const valkey = MULTI;
    const redis: Advisory = { ...MULTI, product: 'redis' };

    expect(computeDatasetVersion([valkey, redis])).toBe(computeDatasetVersion([redis, valkey]));
  });

  it('changes when the two products carry different ranges', () => {
    const valkey = MULTI;
    const redis: Advisory = { ...MULTI, product: 'redis' };
    const redisMoved: Advisory = {
      ...redis,
      affected: [{ branch: '7.4', vulnerableAtOrBelow: '7.4.2' }],
    };

    expect(computeDatasetVersion([valkey, redis])).not.toBe(
      computeDatasetVersion([valkey, redisMoved]),
    );
  });
});
