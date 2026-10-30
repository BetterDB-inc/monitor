import { AnomalyPattern, MetricType } from '../types';

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

  it('rejects a rule with an empty step', () => {
    expect(() =>
      registry.registerSequenceRule({ ...rule, steps: [[MetricType.OPS_PER_SEC], []] }),
    ).toThrow(/at least one metric/);
  });
});
