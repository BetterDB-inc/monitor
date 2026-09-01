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

  it('keeps an NVD branch that the winning GHSA ranges never mention', () => {
    const nvdWithOlderBranch: Advisory = {
      ...NVD_VIEW,
      affected: [
        { branch: '8.0', vulnerableBelow: '8.0.5' },
        { branch: '7.2', vulnerableBelow: '7.2.9' },
      ],
    };
    const { advisories } = normalizeAdvisories(
      [fetched('nvd', [nvdWithOlderBranch]), fetched('ghsa', [GHSA_VIEW])],
      [],
    );
    const nvd = advisories[0].sources.find((entry) => {
      return entry.source === 'nvd';
    });

    expect(advisories[0].affected).toEqual([
      { branch: '8.0', vulnerableAtOrBelow: '8.0.9', patchedAt: '8.0.10' },
      { branch: '7.2', vulnerableBelow: '7.2.9' },
    ]);
    expect(advisories[0].confidence).toBe('exact');
    expect(nvd?.fields).toContain('affected');
  });

  it('refuses to widen a branch-specific winner with a broad wildcard range', () => {
    const { advisories } = normalizeAdvisories(
      [fetched('nvd', [NVD_VIEW]), fetched('ghsa', [GHSA_VIEW])],
      [],
    );

    expect(advisories[0].affected).toEqual(GHSA_VIEW.affected);
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
describe('normalizeAdvisories - one CVE affecting two products', () => {
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
    expect(redis?.affected).toContainEqual({
      branch: '*',
      vulnerableBelow: '7.2.8',
      vulnerableFrom: '2.6.0',
    });
    expect(redis?.affected).toContainEqual({
      branch: '7.4',
      vulnerableBelow: '7.4.3',
      vulnerableFrom: '7.4.0',
    });
    expect(valkey?.affected).toHaveLength(3);
    expect(valkey?.affected).toContainEqual({
      branch: '7.2',
      vulnerableBelow: '7.2.9',
      vulnerableFrom: '7.2.4',
    });
    expect(valkey?.affected).toContainEqual({
      branch: '8.0',
      vulnerableBelow: '8.0.3',
      vulnerableFrom: '8.0.0',
    });
    expect(valkey?.affected).toContainEqual({
      branch: '8.1',
      vulnerableBelow: '8.1.1',
      vulnerableFrom: '8.1.0',
    });
    expect(redis?.affected).not.toContainEqual({ branch: '8.0', vulnerableBelow: '8.0.3' });
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

  it('does not let the merged ranges alias the source advisory', () => {
    const { advisories } = normalizeAdvisories([fetched('ghsa', [GHSA_VIEW])], []);

    expect(advisories[0].affected).not.toBe(GHSA_VIEW.affected);
    expect(advisories[0].affected[0]).not.toBe(GHSA_VIEW.affected[0]);
    expect(advisories[0].affected).toEqual(GHSA_VIEW.affected);
  });
});

// I1 guard: MitreSource guesses the product from the CNA name and can never emit a module
// product, so a rangeless MITRE view must not form a product group of its own - it would
// strand its summary and push a phantom UNKNOWN row onto every engine node.
describe('normalizeAdvisories - rangeless views never manufacture a product', () => {
  const BLOOM_VIEW: Advisory = {
    cveId: 'CVE-2026-80001',
    aliases: ['GHSA-bloom'],
    product: 'valkey-bloom',
    affected: [{ branch: '1.0', vulnerableAtOrBelow: '1.0.2', patchedAt: '1.0.3' }],
    severity: 'high',
    cvssScore: 7.5,
    cwes: [],
    knownExploited: false,
    confidence: 'exact',
    sources: [{ source: 'ghsa', fields: ['affected'] }],
    summary: '',
    references: ['https://ghsa.example/bloom'],
  };
  const MITRE_VIEW: Advisory = {
    cveId: 'CVE-2026-80001',
    aliases: [],
    product: 'valkey',
    affected: [],
    severity: 'medium',
    cwes: [],
    knownExploited: false,
    confidence: 'unversioned',
    sources: [{ source: 'mitre', fields: ['summary'] }],
    summary: 'Integer underflow in the bloom module',
    references: ['https://cveawg.example/CVE-2026-80001'],
  };

  it('attaches a rangeless MITRE view to the ranged advisory instead of splitting it off', () => {
    const { advisories } = normalizeAdvisories(
      [fetched('ghsa', [BLOOM_VIEW]), fetched('mitre', [MITRE_VIEW])],
      [],
    );

    expect(advisories).toHaveLength(1);
    expect(advisories[0].product).toBe('valkey-bloom');
    expect(advisories[0].confidence).toBe('exact');
    expect(advisories[0].affected).toEqual(BLOOM_VIEW.affected);
    expect(advisories[0].summary).toBe('Integer underflow in the bloom module');
  });

  it('never leaves a phantom rangeless advisory for the product MITRE guessed', () => {
    const { advisories } = normalizeAdvisories(
      [fetched('ghsa', [BLOOM_VIEW]), fetched('mitre', [MITRE_VIEW])],
      [],
    );
    const phantom = advisories.find((advisory) => {
      return advisory.product === 'valkey';
    });

    expect(phantom).toBeUndefined();
  });

  it('credits MITRE for the summary it donated to another product group', () => {
    const { advisories } = normalizeAdvisories(
      [fetched('ghsa', [BLOOM_VIEW]), fetched('mitre', [MITRE_VIEW])],
      [],
    );
    const mitre = advisories[0].sources.find((entry) => {
      return entry.source === 'mitre';
    });
    const ghsa = advisories[0].sources.find((entry) => {
      return entry.source === 'ghsa';
    });

    expect(mitre?.fields).toContain('summary');
    expect(mitre?.fields).not.toContain('affected');
    expect(ghsa?.fields).toContain('affected');
  });

  it('attaches a rangeless view to every product group of the same CVE', () => {
    const redisRanged: Advisory = { ...GHSA_VIEW, product: 'redis', summary: '' };
    const valkeyRanged: Advisory = { ...GHSA_VIEW, summary: '' };
    const mitreView: Advisory = { ...MITRE_VIEW, cveId: GHSA_VIEW.cveId, summary: 'shared text' };
    const { advisories } = normalizeAdvisories(
      [fetched('ghsa', [valkeyRanged, redisRanged]), fetched('mitre', [mitreView])],
      [],
    );

    expect(advisories).toHaveLength(2);
    expect(
      advisories.every((advisory) => {
        return advisory.summary === 'shared text';
      }),
    ).toBe(true);
  });

  it('lets a rangeless view stand alone when no other source reported the CVE', () => {
    const { advisories } = normalizeAdvisories([fetched('mitre', [MITRE_VIEW])], []);

    expect(advisories).toHaveLength(1);
    expect(advisories[0].product).toBe('valkey');
    expect(advisories[0].confidence).toBe('unversioned');
    expect(advisories[0].affected).toEqual([]);
  });
});

// I1 counterpart: only MITRE guesses its product. A rangeless GHSA or NVD view names a product
// on authority - the GHSA advisory's own repo, the matched NVD CPE - so it must keep an advisory
// row of its own instead of overwriting another product's verdict fields.
describe('normalizeAdvisories - rangeless authoritative views keep their own product', () => {
  const NVD_REDIS_RANGELESS: Advisory = {
    cveId: GHSA_VIEW.cveId,
    aliases: [],
    product: 'redis',
    affected: [],
    severity: 'critical',
    cvssScore: 9.8,
    cwes: ['CWE-999'],
    knownExploited: false,
    confidence: 'unversioned',
    sources: [{ source: 'nvd', fields: ['summary'] }],
    summary: 'Redis-only: auth bypass in the redis fork',
    references: ['https://nvd.example/redis-only'],
  };

  it('never folds a rangeless NVD redis view into the ranged valkey advisory', () => {
    const { advisories } = normalizeAdvisories(
      [fetched('ghsa', [GHSA_VIEW]), fetched('nvd', [NVD_REDIS_RANGELESS])],
      [],
    );
    const valkey = advisories.find((advisory) => {
      return advisory.product === 'valkey';
    });
    const redis = advisories.find((advisory) => {
      return advisory.product === 'redis';
    });

    expect(advisories).toHaveLength(2);
    expect(valkey?.cvssScore).toBe(8.8);
    expect(valkey?.summary).toBe(GHSA_VIEW.summary);
    expect(valkey?.affected).toEqual(GHSA_VIEW.affected);
    expect(valkey?.cwes).not.toContain('CWE-999');
    expect(valkey?.references).not.toContain('https://nvd.example/redis-only');
    expect(redis?.confidence).toBe('unversioned');
    expect(redis?.summary).toBe(NVD_REDIS_RANGELESS.summary);
  });

  it('keeps a rangeless GHSA view and a rangeless NVD view of one CVE as two products', () => {
    const ghsaRangeless: Advisory = { ...GHSA_VIEW, affected: [], confidence: 'unversioned' };
    const { advisories } = normalizeAdvisories(
      [fetched('ghsa', [ghsaRangeless]), fetched('nvd', [NVD_REDIS_RANGELESS])],
      [],
    );

    expect(advisories).toHaveLength(2);
    expect(
      advisories.map((advisory) => {
        return advisory.product;
      }),
    ).toEqual(expect.arrayContaining(['valkey', 'redis']));
  });

  it('still merges a same-product rangeless view into its ranged group', () => {
    const nvdRangeless: Advisory = { ...NVD_VIEW, affected: [], confidence: 'unversioned' };
    const { advisories } = normalizeAdvisories(
      [fetched('ghsa', [GHSA_VIEW]), fetched('nvd', [nvdRangeless])],
      [],
    );

    expect(advisories).toHaveLength(1);
    expect(advisories[0].product).toBe('valkey');
    expect(advisories[0].confidence).toBe('exact');
    expect(advisories[0].affected).toEqual(GHSA_VIEW.affected);
  });

  it('attaches a rangeless MITRE view to a group only a rangeless NVD view created', () => {
    const ghsaRedisRanged: Advisory = { ...GHSA_VIEW, product: 'redis' };
    const nvdValkeyRangeless: Advisory = {
      ...NVD_VIEW,
      affected: [],
      confidence: 'unversioned',
      summary: '',
    };
    const mitreView: Advisory = {
      cveId: GHSA_VIEW.cveId,
      aliases: [],
      product: 'valkey',
      affected: [],
      severity: 'medium',
      cwes: [],
      knownExploited: false,
      confidence: 'unversioned',
      sources: [{ source: 'mitre', fields: ['summary'] }],
      summary: 'shared mitre text',
      references: [],
    };
    const { advisories } = normalizeAdvisories(
      [
        fetched('ghsa', [ghsaRedisRanged]),
        fetched('nvd', [nvdValkeyRangeless]),
        fetched('mitre', [mitreView]),
      ],
      [],
    );
    const valkey = advisories.find((advisory) => {
      return advisory.product === 'valkey';
    });
    const redis = advisories.find((advisory) => {
      return advisory.product === 'redis';
    });

    expect(advisories).toHaveLength(2);
    expect(valkey?.summary).toBe('shared mitre text');
    expect(valkey?.confidence).toBe('unversioned');
    expect(
      redis?.sources.map((entry) => {
        return entry.source;
      }),
    ).toContain('mitre');
  });
});

// Q2 guard: the range winner's missing optional fields must not blank a value a
// lower-precedence source supplied. severity stays winner-only by ruling.
describe('normalizeAdvisories - field-level fallback', () => {
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

  it('takes the NVD ranges when the GHSA view is unversioned, and credits only NVD', () => {
    const unversioned: Advisory = { ...GHSA_VIEW, affected: [], confidence: 'unversioned' };
    const { advisories } = normalizeAdvisories(
      [fetched('ghsa', [unversioned]), fetched('nvd', [NVD_VIEW])],
      [],
    );
    const ghsa = advisories[0].sources.find((entry) => {
      return entry.source === 'ghsa';
    });
    const nvd = advisories[0].sources.find((entry) => {
      return entry.source === 'nvd';
    });

    expect(advisories[0].affected).toEqual(NVD_VIEW.affected);
    expect(advisories[0].confidence).toBe('broad');
    expect(nvd?.fields).toContain('affected');
    expect(ghsa?.fields).not.toContain('affected');
  });

  it('keeps an advisory no source could version instead of dropping it', () => {
    const unversioned: Advisory = { ...GHSA_VIEW, affected: [], confidence: 'unversioned' };
    const { advisories } = normalizeAdvisories([fetched('ghsa', [unversioned])], []);

    expect(advisories).toHaveLength(1);
    expect(advisories[0].confidence).toBe('unversioned');
    expect(advisories[0].affected).toEqual([]);
  });

  it('treats knownExploited as an OR across views and credits the source that said so', () => {
    const exploited: Advisory = { ...NVD_VIEW, knownExploited: true };
    const { advisories } = normalizeAdvisories(
      [fetched('ghsa', [GHSA_VIEW]), fetched('nvd', [exploited])],
      [],
    );
    const nvd = advisories[0].sources.find((entry) => {
      return entry.source === 'nvd';
    });
    const ghsa = advisories[0].sources.find((entry) => {
      return entry.source === 'ghsa';
    });

    expect(advisories[0].knownExploited).toBe(true);
    expect(nvd?.fields).toContain('knownExploited');
    expect(ghsa?.fields).not.toContain('knownExploited');
  });
});

// Q3 guard: sources exists so the UI can say which source supplied which field.
// Crediting NVD with `affected` after GHSA won the ranges is a falsehood on screen.
describe('normalizeAdvisories - provenance honesty', () => {
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

  it('lists each source exactly once, however many fields it supplied', () => {
    const { advisories } = normalizeAdvisories(
      [fetched('nvd', [NVD_VIEW]), fetched('ghsa', [GHSA_VIEW])],
      [],
    );

    expect(
      advisories[0].sources.map((entry) => {
        return entry.source;
      }),
    ).toEqual(['ghsa', 'nvd']);
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
// It must also hash exactly what changes a verdict or its ranking - no more.
describe('computeDatasetVersion - canonical ordering', () => {
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

  it('is unchanged when ranges sharing a branch arrive in a different order', () => {
    const forward = computeDatasetVersion([
      {
        ...MULTI,
        affected: [
          { branch: '8.0', vulnerableAtOrBelow: '8.0.9', patchedAt: '8.0.10' },
          { branch: '8.0', vulnerableAtOrBelow: '8.0.4' },
          { branch: '8.0', vulnerableAtOrBelow: '8.0.9', patchedAt: '8.0.11' },
        ],
      },
    ]);
    const shuffled = computeDatasetVersion([
      {
        ...MULTI,
        affected: [
          { branch: '8.0', vulnerableAtOrBelow: '8.0.9', patchedAt: '8.0.11' },
          { branch: '8.0', vulnerableAtOrBelow: '8.0.9', patchedAt: '8.0.10' },
          { branch: '8.0', vulnerableAtOrBelow: '8.0.4' },
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

  it('changes when only the product differs', () => {
    const valkey = computeDatasetVersion([MULTI]);
    const redis = computeDatasetVersion([{ ...MULTI, product: 'redis' }]);

    expect(valkey).not.toBe(redis);
  });

  it('changes when any single verdict or ranking field changes', () => {
    const base = computeDatasetVersion([MULTI]);

    expect(computeDatasetVersion([{ ...MULTI, severity: 'critical' }])).not.toBe(base);
    expect(computeDatasetVersion([{ ...MULTI, confidence: 'broad' }])).not.toBe(base);
    expect(computeDatasetVersion([{ ...MULTI, knownExploited: true }])).not.toBe(base);
    expect(computeDatasetVersion([{ ...MULTI, cvssScore: 9.1 }])).not.toBe(base);
    expect(computeDatasetVersion([{ ...MULTI, cveId: 'CVE-2000-0002' }])).not.toBe(base);
  });

  it('changes when any single rendered field changes', () => {
    const base = computeDatasetVersion([MULTI]);

    expect(computeDatasetVersion([{ ...MULTI, aliases: ['GHSA-other'] }])).not.toBe(base);
    expect(computeDatasetVersion([{ ...MULTI, cwes: ['CWE-787'] }])).not.toBe(base);
    expect(
      computeDatasetVersion([{ ...MULTI, references: ['https://elsewhere.example'] }]),
    ).not.toBe(base);
    expect(
      computeDatasetVersion([
        { ...MULTI, sources: [{ source: 'nvd', fields: ['affected', 'summary'] }] },
      ]),
    ).not.toBe(base);
    expect(
      computeDatasetVersion([{ ...MULTI, summary: 'a completely different summary' }]),
    ).not.toBe(base);
  });

  it('changes when only the EPSS score or percentile changes', () => {
    const base = computeDatasetVersion([{ ...MULTI, epssScore: 0.01, epssPercentile: 0.5 }]);
    const rescored = computeDatasetVersion([{ ...MULTI, epssScore: 0.99, epssPercentile: 0.5 }]);
    const repositioned = computeDatasetVersion([
      { ...MULTI, epssScore: 0.01, epssPercentile: 0.99 },
    ]);

    expect(rescored).not.toBe(base);
    expect(repositioned).not.toBe(base);
    expect(rescored).not.toBe(repositioned);
  });

  it('distinguishes an absent optional number from an explicit zero', () => {
    const absent = computeDatasetVersion([MULTI]);
    const zeroed = computeDatasetVersion([{ ...MULTI, epssScore: 0 }]);

    expect(absent).not.toBe(zeroed);
  });
});
