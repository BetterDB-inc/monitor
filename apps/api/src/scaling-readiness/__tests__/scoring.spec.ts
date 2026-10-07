import {
  bandFor,
  DimensionInputs,
  growthHeadroom,
  notApplicable,
  scoreReadiness,
  timeToLimitHeadroom,
  utilizationHeadroom,
  DAY_MS,
} from '../scoring';

const ok = (score: number, detail = 'd') => ({ score, detail });
const excluded = (excludedReason: string) => ({ excludedReason });
const all = (overrides: Partial<DimensionInputs> = {}): DimensionInputs => ({
  memory: ok(100),
  connections: ok(100),
  cpu: ok(100),
  opsTrend: ok(100),
  keyspaceGrowth: ok(100),
  ...overrides,
});

describe('mappings', () => {
  it.each([
    [0.3, 0.95, 100],
    [0.5, 0.95, 100],
    [0.725, 0.95, 50],
    [0.95, 0.95, 0],
    [1.2, 0.95, 0],
    [0.7, 0.9, 50],
    [0.9, 0.9, 0],
  ])('utilizationHeadroom(%p, %p) = %p', (ratio, sat, expected) => {
    expect(utilizationHeadroom(ratio, sat)).toBeCloseTo(expected);
  });

  it.each([
    [-10, 100],
    [0, 100],
    [25, 50],
    [50, 0],
    [Infinity, 0],
  ])('growthHeadroom(%p) = %p', (growth, expected) => {
    expect(growthHeadroom(growth)).toBeCloseTo(expected);
  });

  it.each([
    [60 * DAY_MS, 100],
    [30 * DAY_MS, 100],
    [15.5 * DAY_MS, 50],
    [DAY_MS, 0],
    [0, 0],
  ])('timeToLimitHeadroom(%p) = %p', (ms, expected) => {
    expect(timeToLimitHeadroom(ms)).toBeCloseTo(expected);
  });

  it.each([
    [100, 'green'],
    [70, 'green'],
    [69, 'yellow'],
    [40, 'yellow'],
    [39, 'red'],
    [0, 'red'],
  ])('bandFor(%p) = %p', (score, band) => {
    expect(bandFor(score)).toBe(band);
  });
});

describe('scoreReadiness', () => {
  it('scores full headroom as 100 with memory closest to its limit', () => {
    const r = scoreReadiness('c', 1, all());
    expect(r.score).toBe(100);
    expect(r.band).toBe('green');
    expect(r.cappedBy).toBeNull();
    expect(r.bindingDimension).toBe('memory');
    expect(r.summary).toBe('Plenty of headroom; memory is closest to its limit.');
  });

  it('caps the score at the worst dimension plus 15', () => {
    const r = scoreReadiness('c', 1, all({ memory: ok(10, '93% of 4 GB') }));
    expect(r.score).toBe(25);
    expect(r.band).toBe('red');
    expect(r.cappedBy).toBe('memory');
    expect(r.bindingDimension).toBe('memory');
    expect(r.summary).toBe('Memory is your binding constraint (93% of 4 GB).');
  });

  it('renormalizes weights over available dimensions', () => {
    const r = scoreReadiness(
      'c',
      1,
      all({ memory: ok(80), connections: excluded('Not reported over OTLP') }),
    );
    expect(r.score).toBe(93);
    expect(r.cappedBy).toBeNull();
    const memory = r.dimensions.find((d) => d.key === 'memory')!;
    expect(memory.contribution).toBeCloseTo(30);
    const connections = r.dimensions.find((d) => d.key === 'connections')!;
    expect(connections).toMatchObject({
      score: null,
      contribution: null,
      excludedReason: 'Not reported over OTLP',
      weight: 20,
    });
  });

  it('applies the cap after renormalization', () => {
    const r = scoreReadiness('c', 1, all({ memory: ok(50, '73% of 1 GB'), connections: excluded('x') }));
    expect(r.score).toBe(65);
    expect(r.band).toBe('yellow');
    expect(r.cappedBy).toBe('memory');
  });

  it('breaks ties by weight, then by dimension order', () => {
    expect(scoreReadiness('c', 1, all({ cpu: ok(60), opsTrend: ok(60) })).bindingDimension).toBe('cpu');
    expect(scoreReadiness('c', 1, all({ cpu: ok(60), connections: ok(60) })).bindingDimension).toBe(
      'connections',
    );
  });

  it('uses the sentence label for CPU in the green summary', () => {
    const r = scoreReadiness('c', 1, all({ cpu: ok(80) }));
    expect(r.summary).toBe('Plenty of headroom; CPU is closest to its limit.');
  });

  it('returns a null score when no dimension is available', () => {
    const r = scoreReadiness('c', 1, {
      memory: excluded('maxmemory not set'),
      connections: excluded('a'),
      cpu: excluded('No CPU samples yet'),
      opsTrend: excluded('Needs 24h of history'),
      keyspaceGrowth: excluded('Needs 24h of history'),
    });
    expect(r).toMatchObject({ score: null, band: null, bindingDimension: null, cappedBy: null });
    expect(r.summary).toBe('Not enough data yet');
    expect(r.dimensions).toHaveLength(5);
  });

  it('returns dimensions in fixed order with integer scores', () => {
    const r = scoreReadiness('c', 1, all({ memory: ok(33.6) }));
    expect(r.dimensions.map((d) => d.key)).toEqual([
      'memory',
      'connections',
      'cpu',
      'opsTrend',
      'keyspaceGrowth',
    ]);
    expect(r.dimensions[0].score).toBe(34);
  });
});

describe('notApplicable', () => {
  it('builds a null result with every dimension excluded', () => {
    const r = notApplicable('c', 1, 'Not applicable to Sentinel');
    expect(r.score).toBeNull();
    expect(r.summary).toBe('Not applicable to Sentinel');
    expect(r.dimensions.every((d) => d.excludedReason === 'Not applicable to Sentinel')).toBe(true);
  });
});
