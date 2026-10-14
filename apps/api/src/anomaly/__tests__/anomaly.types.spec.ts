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

  it('sanitizers strip null and Infinity', () => {
    expect(
      sanitizeStoredOverride({ criticalAbsolute: null as unknown as number }),
    ).not.toHaveProperty('criticalAbsolute');
    const api = toApiDetectorConfig(
      resolveDetectorConfig(MetricType.acl_denied, {
        acl_denied: { criticalAbsolute: Number.POSITIVE_INFINITY },
      }),
    );
    expect(api).not.toHaveProperty('criticalAbsolute');
    expect(JSON.stringify(api)).not.toContain('null');
  });
});
