import {
  MetricType,
  normalizeDetectorConfigMap,
  resolveDetectorConfig,
  sanitizeStoredOverride,
  toApiDetectorConfig,
} from '../anomaly.types';

describe('disabled absolute threshold normalization', () => {
  it('maps null absolutes back to Infinity', () => {
    const out = normalizeDetectorConfigMap({
      acl_denied: { criticalAbsolute: null, warningAbsolute: 5 },
    });
    expect(out.acl_denied?.criticalAbsolute).toBe(Number.POSITIVE_INFINITY);
    expect(out.acl_denied?.warningAbsolute).toBe(5);
  });

  it('returns {} for null / non-object input', () => {
    expect(normalizeDetectorConfigMap(null)).toEqual({});
    expect(normalizeDetectorConfigMap('x')).toEqual({});
  });

  it('resolveDetectorConfig never yields a null absolute', () => {
    const resolved = resolveDetectorConfig(MetricType.acl_denied, {
      acl_denied: { criticalAbsolute: null as unknown as number },
    });
    expect(resolved.criticalAbsolute).toBe(Number.POSITIVE_INFINITY);
  });

  it('sanitizers never emit null; overrides map disabled to 0', () => {
    expect(sanitizeStoredOverride({ criticalAbsolute: null as unknown as number })).toEqual({
      criticalAbsolute: 0,
    });
    expect(
      sanitizeStoredOverride({ criticalAbsolute: Number.POSITIVE_INFINITY, warningZScore: 2.5 }),
    ).toEqual({ criticalAbsolute: 0, warningZScore: 2.5 });
    expect(sanitizeStoredOverride({ warningZScore: 2.5 })).toEqual({ warningZScore: 2.5 });
    const api = toApiDetectorConfig(
      resolveDetectorConfig(MetricType.acl_denied, {
        acl_denied: { criticalAbsolute: Number.POSITIVE_INFINITY },
      }),
    );
    expect(api).not.toHaveProperty('criticalAbsolute');
    expect(JSON.stringify(api)).not.toContain('null');
  });
});
