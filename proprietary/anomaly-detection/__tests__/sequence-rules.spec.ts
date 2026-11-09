import { AnomalyPattern, AnomalyType, MetricType } from '../types';

describe('sequence rule registry', () => {
  let registry: typeof import('../sequence-rules');

  beforeEach(() => {
    jest.isolateModules(() => {
      registry = require('../sequence-rules');
    });
  });

  const rule = {
    pattern: AnomalyPattern.BATCH_JOB,
    steps: [[MetricType.OPS_PER_SEC], [MetricType.MEMORY_USED]],
    maxSpanMs: 60_000,
    diagnosis: 'd',
    recommendations: [],
  };

  it('starts empty and returns registered rules', () => {
    expect(registry.getSequenceRules()).toEqual([]);

    registry.registerSequenceRule(rule);

    expect(registry.getSequenceRules()).toEqual([rule]);
  });

  it('rejects a second rule for the same pattern', () => {
    registry.registerSequenceRule(rule);

    expect(() => registry.registerSequenceRule(rule)).toThrow(/already registered/);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a maxSpanMs of %s',
    (maxSpanMs) => {
      expect(() => registry.registerSequenceRule({ ...rule, maxSpanMs })).toThrow(/maxSpanMs/);
    },
  );

  it('rejects a rule with an empty step', () => {
    expect(() =>
      registry.registerSequenceRule({ ...rule, steps: [[MetricType.OPS_PER_SEC], []] }),
    ).toThrow(/at least one metric/);
  });

  it.each([
    [{ 0: 60_000 }],
    [{ 2: 60_000 }],
    [{ 1: 0 }],
    [{ 1: Number.NaN }],
  ])('rejects a lead of %j', (leadMs) => {
    expect(() => registry.registerSequenceRule({ ...rule, leadMs })).toThrow(/lead/);
  });

  it('rejects a direction on a metric the rule does not use', () => {
    expect(() =>
      registry.registerSequenceRule({ ...rule, directions: { [MetricType.INPUT_KBPS]: 'rise' } }),
    ).toThrow(/direction on input_kbps/);
  });

  it('rejects a rule that supersedes itself', () => {
    expect(() =>
      registry.registerSequenceRule({ ...rule, supersedes: [AnomalyPattern.BATCH_JOB] }),
    ).toThrow(/supersede itself/);
  });

  describe('fills', () => {
    const directed = { ...rule, directions: { [MetricType.OPS_PER_SEC]: 'rise' as const } };

    it.each([
      [AnomalyType.SPIKE, true],
      [AnomalyType.DROP, false],
      [undefined, true],
    ])('takes an %s ops/sec event on a rise step: %s', (anomalyType, expected) => {
      expect(
        registry.fills(directed, directed.steps[0], { metricType: MetricType.OPS_PER_SEC, anomalyType }),
      ).toBe(expected);
    });

    it('takes either direction on a step without one', () => {
      expect(
        registry.fills(directed, directed.steps[1], {
          metricType: MetricType.MEMORY_USED,
          anomalyType: AnomalyType.DROP,
        }),
      ).toBe(true);
    });

    it('does not take a metric outside the step', () => {
      expect(registry.fills(directed, directed.steps[1], { metricType: MetricType.OPS_PER_SEC })).toBe(false);
    });
  });

  it('accepts a lead on a later step', () => {
    registry.registerSequenceRule({ ...rule, leadMs: { 1: 60_000 } });

    expect(registry.getSequenceRules()).toHaveLength(1);
  });
});
