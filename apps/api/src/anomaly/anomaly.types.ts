import type { SpikeDetectorConfig } from '@proprietary/anomaly-detection/types';

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

export const ABSOLUTE_FIELDS = ['warningAbsolute', 'criticalAbsolute'] as const;

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
    out[key as MetricType] = cfg;
  }
  return out;
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
 * Strip Infinity sentinels from a stored partial override before returning it
 * over the API. Unlike toApiDetectorConfig (which operates on the fully-resolved
 * Required<DetectorConfig>), this preserves the partial shape — fields that
 * were not overridden stay absent — and only removes the specific Infinity
 * poison that JSON.stringify would otherwise emit as null.
 */
export function sanitizeStoredOverride(override: DetectorConfig): DetectorConfig {
  const out: DetectorConfig = { ...override };
  if (out.warningAbsolute !== undefined && !Number.isFinite(out.warningAbsolute)) {
    delete out.warningAbsolute;
  }
  if (out.criticalAbsolute !== undefined && !Number.isFinite(out.criticalAbsolute)) {
    delete out.criticalAbsolute;
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
