import { describe, expect, it } from 'vitest';
import type {
  AnomalyDetectorConfigEntry,
  AnomalyDetectorMetric,
  AnomalyDetectorSettingsResponse,
} from '@betterdb/shared';
import { METRIC_ORDER } from './metric-meta';
import {
  buildPatch,
  defaultLabel,
  draftsFrom,
  fieldSource,
  toDraft,
  validateMetricDraft,
  type Drafts,
  type MetricDraft,
} from './threshold-form';

// Mirrors DETECTOR_DEFAULTS in apps/api/src/anomaly/anomaly.types.ts.
const Z: AnomalyDetectorConfigEntry = {
  warningZScore: 2,
  criticalZScore: 3,
  consecutiveRequired: 3,
  cooldownMs: 60_000,
};

const DEFAULTS: Record<AnomalyDetectorMetric, AnomalyDetectorConfigEntry> = {
  connections: { ...Z },
  ops_per_sec: { ...Z },
  memory_used: { ...Z, warningZScore: 2.5, criticalZScore: 3.5 },
  input_kbps: { ...Z },
  output_kbps: { ...Z },
  slowlog_last_id: {
    ...Z,
    warningZScore: 1.5,
    criticalZScore: 2.5,
    consecutiveRequired: 1,
    cooldownMs: 30_000,
  },
  acl_denied: {
    ...Z,
    warningZScore: 1.5,
    criticalZScore: 2.5,
    warningAbsolute: 10,
    criticalAbsolute: 50,
    consecutiveRequired: 2,
    cooldownMs: 30_000,
  },
  evicted_keys: { ...Z, consecutiveRequired: 2, cooldownMs: 30_000 },
  blocked_clients: { ...Z },
  keyspace_misses: { ...Z },
  fragmentation_ratio: {
    ...Z,
    warningAbsolute: 1.5,
    criticalAbsolute: 2.0,
    consecutiveRequired: 5,
    cooldownMs: 120_000,
  },
};

function makeData(
  overrides: AnomalyDetectorSettingsResponse['overrides'] = {},
  resolved: Partial<Record<AnomalyDetectorMetric, AnomalyDetectorConfigEntry>> = {},
): AnomalyDetectorSettingsResponse {
  return {
    defaults: DEFAULTS,
    overrides,
    resolved: { ...DEFAULTS, ...resolved },
  };
}

const DATA = makeData();

function edit(
  drafts: Drafts,
  metric: AnomalyDetectorMetric,
  changes: Partial<MetricDraft>,
): Drafts {
  return { ...drafts, [metric]: { ...drafts[metric], ...changes } };
}

describe('toDraft / draftsFrom', () => {
  it('maps numbers to strings and a missing absolute to an empty string', () => {
    const draft = toDraft(DEFAULTS.connections);
    expect(draft.warningZScore).toBe('2');
    expect(draft.cooldownMs).toBe('60000');
    expect(draft.warningAbsolute).toBe('');
    expect(draft.criticalAbsolute).toBe('');
    expect(toDraft(DEFAULTS.acl_denied).warningAbsolute).toBe('10');
  });

  it('returns all 11 metrics in METRIC_ORDER', () => {
    const drafts = draftsFrom(DATA);
    expect(METRIC_ORDER).toHaveLength(11);
    expect(Object.keys(drafts)).toEqual([...METRIC_ORDER]);
  });
});

describe('buildPatch', () => {
  const base = draftsFrom(DATA);

  it('returns {} for untouched drafts', () => {
    expect(buildPatch(base, DATA)).toEqual({});
  });

  it('sends only the changed field', () => {
    const patch = buildPatch(edit(base, 'connections', { warningZScore: '2.5' }), DATA);
    expect(patch).toEqual({ connections: { warningZScore: 2.5 } });
    expect(JSON.stringify(patch)).not.toContain('null');
  });

  it('sends 0 when an active absolute is cleared', () => {
    const patch = buildPatch(edit(base, 'acl_denied', { warningAbsolute: '' }), DATA);
    expect(patch).toEqual({ acl_denied: { warningAbsolute: 0 } });
    expect(JSON.stringify(patch)).not.toContain('null');
  });

  it('treats typing 0 into an active absolute like clearing it', () => {
    const patch = buildPatch(edit(base, 'acl_denied', { warningAbsolute: '0' }), DATA);
    expect(patch).toEqual({ acl_denied: { warningAbsolute: 0 } });
  });

  it('omits an already-off absolute that is left empty', () => {
    const patch = buildPatch(edit(base, 'connections', { warningAbsolute: '' }), DATA);
    expect(patch).toEqual({});
  });

  it('sends a value for an off absolute that is turned on', () => {
    const patch = buildPatch(edit(base, 'connections', { warningAbsolute: '25' }), DATA);
    expect(patch).toEqual({ connections: { warningAbsolute: 25 } });
    expect(JSON.stringify(patch)).not.toContain('null');
  });

  it('produces no patch for an override that disabled a default and is left empty', () => {
    const { warningAbsolute: _omitted, ...rest } = DEFAULTS.acl_denied;
    const data = makeData({ acl_denied: { warningAbsolute: 0 } }, { acl_denied: rest });
    const drafts = draftsFrom(data);
    expect(drafts.acl_denied.warningAbsolute).toBe('');
    expect(buildPatch(drafts, data)).toEqual({});
  });

  it('keeps changes across two metrics to exactly those two keys', () => {
    const drafts = edit(edit(base, 'connections', { cooldownMs: '5000' }), 'fragmentation_ratio', {
      criticalAbsolute: '',
    });
    const patch = buildPatch(drafts, DATA);
    expect(patch).toEqual({
      connections: { cooldownMs: 5000 },
      fragmentation_ratio: { criticalAbsolute: 0 },
    });
    expect(JSON.stringify(patch)).not.toContain('null');
  });
});

describe('validateMetricDraft', () => {
  const base = toDraft(DEFAULTS.acl_denied);
  const check = (changes: Partial<MetricDraft>) => validateMetricDraft({ ...base, ...changes });

  it('accepts the unchanged defaults', () => {
    expect(check({})).toEqual({});
  });

  it('enforces the warningZScore bounds', () => {
    expect(check({ warningZScore: '0.5', criticalZScore: '3' }).warningZScore).toBeUndefined();
    expect(check({ warningZScore: '0.49' }).warningZScore).toBeDefined();
    expect(check({ warningZScore: '10', criticalZScore: '15' }).warningZScore).toBeUndefined();
    expect(check({ warningZScore: '10.01', criticalZScore: '15' }).warningZScore).toBeDefined();
  });

  it('enforces the criticalZScore bounds', () => {
    expect(check({ warningZScore: '0.5', criticalZScore: '1' }).criticalZScore).toBeUndefined();
    expect(check({ criticalZScore: '15' }).criticalZScore).toBeUndefined();
    expect(check({ criticalZScore: '15.1' }).criticalZScore).toBeDefined();
  });

  it('enforces consecutiveRequired as an integer from 1 to 20', () => {
    expect(check({ consecutiveRequired: '1.5' }).consecutiveRequired).toMatch(/whole number/);
    expect(check({ consecutiveRequired: '0' }).consecutiveRequired).toMatch(/between 1 and 20/);
    expect(check({ consecutiveRequired: '21' }).consecutiveRequired).toMatch(/between 1 and 20/);
    expect(check({ consecutiveRequired: '20' }).consecutiveRequired).toBeUndefined();
  });

  it('enforces the cooldownMs bounds', () => {
    expect(check({ cooldownMs: '999' }).cooldownMs).toBeDefined();
    expect(check({ cooldownMs: '3600001' }).cooldownMs).toBeDefined();
    expect(check({ cooldownMs: '1000' }).cooldownMs).toBeUndefined();
    expect(check({ cooldownMs: '3600000' }).cooldownMs).toBeUndefined();
  });

  it('rejects unparseable text', () => {
    expect(check({ warningZScore: 'abc' }).warningZScore).toBe('Enter a number');
  });

  it('rejects a negative absolute', () => {
    expect(check({ warningAbsolute: '-1' }).warningAbsolute).toMatch(/0 or more/);
  });

  it('requires warning z-score below critical', () => {
    expect(check({ warningZScore: '3', criticalZScore: '3' }).criticalZScore).toMatch(/greater/);
    expect(check({ warningZScore: '3', criticalZScore: '2' }).criticalZScore).toMatch(/greater/);
  });

  it('requires warning absolute below critical when both are on', () => {
    expect(check({ warningAbsolute: '100', criticalAbsolute: '50' }).criticalAbsolute).toMatch(
      /greater/,
    );
    expect(
      check({ warningAbsolute: '50', criticalAbsolute: '100' }).criticalAbsolute,
    ).toBeUndefined();
  });

  it('does not order an absolute that is off', () => {
    expect(check({ warningAbsolute: '100', criticalAbsolute: '' })).toEqual({});
    expect(check({ warningAbsolute: '', criticalAbsolute: '5' })).toEqual({});
    expect(check({ warningAbsolute: '100', criticalAbsolute: '0' })).toEqual({});
  });

  it('flags an empty required field', () => {
    expect(check({ cooldownMs: '' }).cooldownMs).toMatch(/Required/);
    expect(check({ warningZScore: '  ' }).warningZScore).toMatch(/Required/);
  });
});

describe('fieldSource / defaultLabel', () => {
  it('reports default, override and override-off', () => {
    const data = makeData({
      connections: { warningZScore: 2.5 },
      acl_denied: { warningAbsolute: 0 },
    });
    expect(fieldSource(data, 'connections', 'criticalZScore')).toBe('default');
    expect(fieldSource(data, 'connections', 'warningZScore')).toBe('override');
    expect(fieldSource(data, 'acl_denied', 'warningAbsolute')).toBe('override-off');
  });

  it('labels a missing default absolute as off', () => {
    expect(defaultLabel(DATA, 'connections', 'warningAbsolute')).toBe('off');
    expect(defaultLabel(DATA, 'connections', 'warningZScore')).toBe('2');
    expect(defaultLabel(DATA, 'acl_denied', 'criticalAbsolute')).toBe('50');
  });
});
