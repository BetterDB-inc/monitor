import type { SpikeDetectorConfig } from '@proprietary/anomaly-detection/types';
import { ANOMALY_DETECTOR_METRICS, AnomalyDetectorMetric } from '@betterdb/shared';

export enum MetricType {
  connections = 'connections',
  ops_per_sec = 'ops_per_sec',
  memory_used = 'memory_used',
  input_kbps = 'input_kbps',
  output_kbps = 'output_kbps',
  slowlog_last_id = 'slowlog_last_id',
  acl_denied = 'acl_denied',
  evicted_keys = 'evicted_keys',
  blocked_clients = 'blocked_clients',
  keyspace_misses = 'keyspace_misses',
  fragmentation_ratio = 'fragmentation_ratio',
}

export interface DetectorConfig {
  warningZScore?: number;
  criticalZScore?: number;
  warningAbsolute?: number;
  criticalAbsolute?: number;
  consecutiveRequired?: number;
  cooldownMs?: number;
}

export type DetectorConfigMap = Partial<Record<MetricType, DetectorConfig>>;

// Fails to compile if MetricType and the shared list diverge.
const _metricsInSync: [AnomalyDetectorMetric] extends [`${MetricType}`]
  ? [`${MetricType}`] extends [AnomalyDetectorMetric]
    ? true
    : never
  : never = true;
void _metricsInSync;

export const ABSOLUTE_FIELDS = ['warningAbsolute', 'criticalAbsolute'] as const;

/** Non-absolute fields: must always be finite numbers. A null/non-finite value
 *  (e.g. persisted before null was rejected) falls back to the default. */
export const FINITE_FIELDS = [
  'warningZScore',
  'criticalZScore',
  'consecutiveRequired',
  'cooldownMs',
] as const;

/**
 * SQL adapters persist detector config as JSON, which serializes the Infinity
 * "disabled" sentinel as null. Map null back to Infinity so a disabled
 * absolute threshold never becomes `value >= null` (i.e. `>= 0`).
 * Also tolerates null/non-object input (returns {}).
 */
export function normalizeDetectorConfigMap(map: unknown): DetectorConfigMap {
  if (!map || typeof map !== 'object') return {};
  const out: DetectorConfigMap = {};
  for (const [key, raw] of Object.entries(map as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const cfg = { ...(raw as DetectorConfig) };
    for (const f of ABSOLUTE_FIELDS) {
      if ((cfg as Record<string, unknown>)[f] === null) cfg[f] = Number.POSITIVE_INFINITY;
    }
    for (const f of FINITE_FIELDS) {
      const v = (cfg as Record<string, unknown>)[f];
      if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v))) delete cfg[f];
    }
    if (Object.keys(cfg).length === 0) continue;
    out[key as MetricType] = cfg;
  }
  return out;
}

/** Stable comparison of two override maps. Treats Infinity/null absolutes as the
 *  same "disabled" value, ignores key order, and ignores empty overrides. */
export function detectorConfigEquals(a: DetectorConfigMap, b: DetectorConfigMap): boolean {
  const canon = (m: DetectorConfigMap) => {
    const n = normalizeDetectorConfigMap(m);
    return JSON.stringify(
      Object.keys(n)
        .sort()
        .map((k) => {
          const cfg = n[k as MetricType] as Record<string, number>;
          return [
            k,
            Object.keys(cfg)
              .sort()
              .map((f) => [f, Number.isFinite(cfg[f]) ? cfg[f] : 'Infinity']),
          ];
        }),
    );
  };
  return canon(a) === canon(b);
}

const NO_ABSOLUTE = Number.POSITIVE_INFINITY;

const zScoreDefaults = {
  warningZScore: 2.0,
  criticalZScore: 3.0,
  warningAbsolute: NO_ABSOLUTE,
  criticalAbsolute: NO_ABSOLUTE,
  consecutiveRequired: 3,
  cooldownMs: 60_000,
} satisfies Required<DetectorConfig>;

/** Defaults mirror hardcoded thresholds in proprietary/anomaly-detection/anomaly.service.ts */
export const DETECTOR_DEFAULTS: Record<MetricType, Required<DetectorConfig>> = {
  [MetricType.connections]: { ...zScoreDefaults },
  [MetricType.ops_per_sec]: { ...zScoreDefaults },
  [MetricType.memory_used]: {
    ...zScoreDefaults,
    warningZScore: 2.5,
    criticalZScore: 3.5,
  },
  [MetricType.input_kbps]: { ...zScoreDefaults },
  [MetricType.output_kbps]: { ...zScoreDefaults },
  [MetricType.slowlog_last_id]: {
    ...zScoreDefaults,
    warningZScore: 1.5,
    criticalZScore: 2.5,
    consecutiveRequired: 1,
    cooldownMs: 30_000,
  },
  [MetricType.acl_denied]: {
    ...zScoreDefaults,
    warningZScore: 1.5,
    criticalZScore: 2.5,
    warningAbsolute: 10,
    criticalAbsolute: 50,
    consecutiveRequired: 2,
    cooldownMs: 30_000,
  },
  [MetricType.evicted_keys]: {
    ...zScoreDefaults,
    consecutiveRequired: 2,
    cooldownMs: 30_000,
  },
  [MetricType.blocked_clients]: { ...zScoreDefaults },
  [MetricType.keyspace_misses]: { ...zScoreDefaults },
  [MetricType.fragmentation_ratio]: {
    ...zScoreDefaults,
    warningAbsolute: 1.5,
    criticalAbsolute: 2.0,
    consecutiveRequired: 5,
    cooldownMs: 120_000,
  },
};

export function resolveDetectorConfig(
  metric: MetricType,
  overrides: DetectorConfigMap,
): Required<DetectorConfig> {
  const merged = { ...DETECTOR_DEFAULTS[metric], ...overrides[metric] } as Required<DetectorConfig>;
  // Defensive: a null/undefined absolute (e.g. from a JSON round-trip) means "disabled".
  for (const f of ABSOLUTE_FIELDS) {
    const v = merged[f] as number | null | undefined;
    if (v === null || v === undefined) merged[f] = Number.POSITIVE_INFINITY;
  }
  for (const f of FINITE_FIELDS) {
    const v = merged[f] as unknown;
    if (!(typeof v === 'number' && Number.isFinite(v))) merged[f] = DETECTOR_DEFAULTS[metric][f];
  }
  return merged;
}

/** Strips Infinity sentinels before JSON serialization. Omits absolute fields
 *  when they represent "no threshold configured" (i.e., Infinity). */
export function toApiDetectorConfig(config: Required<DetectorConfig>): DetectorConfig {
  const out: DetectorConfig = {
    warningZScore: config.warningZScore,
    criticalZScore: config.criticalZScore,
    consecutiveRequired: config.consecutiveRequired,
    cooldownMs: config.cooldownMs,
  };
  if (Number.isFinite(config.warningAbsolute)) out.warningAbsolute = config.warningAbsolute;
  if (Number.isFinite(config.criticalAbsolute)) out.criticalAbsolute = config.criticalAbsolute;
  return out;
}

/**
 * Prepare a stored partial override for the API. Preserves the partial shape
 * (fields that were not overridden stay absent). A disabled absolute threshold
 * (stored as the Infinity sentinel, or null after a SQL JSON round-trip) is
 * emitted as 0, the same value PATCH accepts to disable it, so an override
 * that disables a default absolute threshold is distinguishable from no
 * override and round-trips through GET → PATCH unchanged. Never emits null.
 */
export function sanitizeStoredOverride(override: DetectorConfig): DetectorConfig {
  const out: DetectorConfig = { ...override };
  for (const f of ABSOLUTE_FIELDS) {
    if (!(f in out)) continue;
    const v = (out as Record<string, unknown>)[f];
    if (v === undefined) {
      delete out[f];
    } else if (v === null || (typeof v === 'number' && !Number.isFinite(v))) {
      out[f] = 0;
    }
  }
  return out;
}

export function toSpikeDetectorConfig(
  config: Required<DetectorConfig>,
): Required<SpikeDetectorConfig> {
  return {
    warningZScore: config.warningZScore,
    criticalZScore: config.criticalZScore,
    warningThreshold: config.warningAbsolute,
    criticalThreshold: config.criticalAbsolute,
    consecutiveRequired: config.consecutiveRequired,
    cooldownMs: config.cooldownMs,
    detectDrops: false,
  };
}

/** Generic z-score defaults for metrics without API config (e.g. cpu_utilization). */
export const DEFAULT_SPIKE_CONFIG: Required<SpikeDetectorConfig> =
  toSpikeDetectorConfig(zScoreDefaults);

export const API_METRIC_TYPES = Object.values(MetricType);
