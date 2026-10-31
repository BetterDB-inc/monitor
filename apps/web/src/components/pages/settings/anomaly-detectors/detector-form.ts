import type { AnomalyDetectorConfigEntry, AnomalyDetectorMetric } from '@betterdb/shared';

export const ANOMALY_DETECTORS_QUERY_KEY = ['anomaly-detectors'] as const;

export const METRIC_UNITS: Record<AnomalyDetectorMetric, string> = {
  connections: 'connected clients',
  ops_per_sec: 'ops/s',
  memory_used: 'bytes',
  input_kbps: 'KB/s',
  output_kbps: 'KB/s',
  slowlog_last_id: 'new slowlog entries per poll',
  acl_denied: 'denials',
  evicted_keys: 'keys',
  blocked_clients: 'clients',
  keyspace_misses: 'misses',
  fragmentation_ratio: 'ratio',
  error_replies: 'error replies/s',
};

export const LIFETIME_COUNTER_METRICS: ReadonlySet<AnomalyDetectorMetric> = new Set<AnomalyDetectorMetric>([
  'acl_denied',
  'evicted_keys',
  'keyspace_misses',
]);

export type AbsoluteField = { enabled: boolean; value: string };

export interface DetectorFormState {
  warningZScore: string;
  criticalZScore: string;
  warningAbsolute: AbsoluteField;
  criticalAbsolute: AbsoluteField;
  consecutiveRequired: string;
  cooldownSeconds: string;
}

export type DetectorFormErrors = Partial<Record<keyof DetectorFormState, string>>;

export type DetectorSave =
  | { kind: 'reset' }
  | { kind: 'patch'; entry: AnomalyDetectorConfigEntry };

type NumericField = 'warningZScore' | 'criticalZScore' | 'consecutiveRequired';
type AbsoluteKey = 'warningAbsolute' | 'criticalAbsolute';

const NUMERIC_FIELDS: NumericField[] = ['warningZScore', 'criticalZScore', 'consecutiveRequired'];
const ABSOLUTE_FIELDS: AbsoluteKey[] = ['warningAbsolute', 'criticalAbsolute'];
const ENTRY_FIELDS: (keyof AnomalyDetectorConfigEntry)[] = [
  ...NUMERIC_FIELDS,
  ...ABSOLUTE_FIELDS,
  'cooldownMs',
];

function parse(value: string): number {
  return value.trim() === '' ? NaN : Number(value);
}

function inRange(n: number, min: number, max: number): boolean {
  return Number.isFinite(n) && n >= min && n <= max;
}

function defaultCooldownSeconds(defaults: AnomalyDetectorConfigEntry): number | undefined {
  return defaults.cooldownMs === undefined ? undefined : defaults.cooldownMs / 1000;
}

function shown(value: number | undefined, fallback: number | undefined): string {
  return value === undefined || value === fallback ? '' : String(value);
}

export function toFormState(
  resolved: AnomalyDetectorConfigEntry,
  defaults: AnomalyDetectorConfigEntry,
): DetectorFormState {
  const absolute = (key: AbsoluteKey): AbsoluteField => ({
    enabled: resolved[key] !== undefined,
    value: shown(resolved[key], defaults[key]),
  });
  return {
    warningZScore: shown(resolved.warningZScore, defaults.warningZScore),
    criticalZScore: shown(resolved.criticalZScore, defaults.criticalZScore),
    warningAbsolute: absolute('warningAbsolute'),
    criticalAbsolute: absolute('criticalAbsolute'),
    consecutiveRequired: shown(resolved.consecutiveRequired, defaults.consecutiveRequired),
    cooldownSeconds: shown(
      resolved.cooldownMs === undefined ? undefined : resolved.cooldownMs / 1000,
      defaultCooldownSeconds(defaults),
    ),
  };
}

export function fillDefaults(
  form: DetectorFormState,
  defaults: AnomalyDetectorConfigEntry,
): DetectorFormState {
  const fill = (value: string, fallback: number | undefined) =>
    value.trim() === '' && fallback !== undefined ? String(fallback) : value;
  const absolute = (key: AbsoluteKey): AbsoluteField => ({
    enabled: form[key].enabled,
    value: form[key].enabled ? fill(form[key].value, defaults[key]) : form[key].value,
  });
  return {
    warningZScore: fill(form.warningZScore, defaults.warningZScore),
    criticalZScore: fill(form.criticalZScore, defaults.criticalZScore),
    warningAbsolute: absolute('warningAbsolute'),
    criticalAbsolute: absolute('criticalAbsolute'),
    consecutiveRequired: fill(form.consecutiveRequired, defaults.consecutiveRequired),
    cooldownSeconds: fill(form.cooldownSeconds, defaultCooldownSeconds(defaults)),
  };
}

export function validateForm(
  form: DetectorFormState,
  defaults: AnomalyDetectorConfigEntry,
): DetectorFormErrors {
  const filled = fillDefaults(form, defaults);
  const errors: DetectorFormErrors = {};

  const warnZ = parse(filled.warningZScore);
  const critZ = parse(filled.criticalZScore);
  if (!inRange(warnZ, 0.5, 10)) errors.warningZScore = 'Must be between 0.5 and 10';
  if (!inRange(critZ, 1, 15)) errors.criticalZScore = 'Must be between 1 and 15';
  else if (!errors.warningZScore && critZ <= warnZ) {
    errors.criticalZScore = 'Must be greater than the warning z-score';
  }

  for (const key of ABSOLUTE_FIELDS) {
    const field = filled[key];
    if (!field.enabled) continue;
    if (field.value.trim() === '') errors[key] = 'Enter a value or turn this threshold off';
    else if (!(parse(field.value) > 0)) errors[key] = 'Must be greater than 0, or turn this threshold off';
  }
  if (
    filled.warningAbsolute.enabled &&
    filled.criticalAbsolute.enabled &&
    !errors.warningAbsolute &&
    !errors.criticalAbsolute &&
    parse(filled.criticalAbsolute.value) <= parse(filled.warningAbsolute.value)
  ) {
    errors.criticalAbsolute = 'Must be greater than the warning threshold';
  }

  const consecutive = parse(filled.consecutiveRequired);
  if (!Number.isInteger(consecutive) || !inRange(consecutive, 1, 20)) {
    errors.consecutiveRequired = 'Must be a whole number between 1 and 20';
  }
  if (!inRange(parse(filled.cooldownSeconds), 1, 3600)) {
    errors.cooldownSeconds = 'Must be between 1 and 3600 seconds';
  }
  return errors;
}

export function buildSave(
  form: DetectorFormState,
  defaults: AnomalyDetectorConfigEntry,
  resolved: AnomalyDetectorConfigEntry,
): DetectorSave {
  const filled = fillDefaults(form, defaults);
  const target: AnomalyDetectorConfigEntry = {
    warningZScore: parse(filled.warningZScore),
    criticalZScore: parse(filled.criticalZScore),
    consecutiveRequired: parse(filled.consecutiveRequired),
    cooldownMs: Math.round(parse(filled.cooldownSeconds) * 1000),
  };
  for (const key of ABSOLUTE_FIELDS) {
    if (filled[key].enabled) target[key] = parse(filled[key].value);
  }
  if (!isCustomized(target, defaults)) return { kind: 'reset' };
  const entry: AnomalyDetectorConfigEntry = {};
  for (const key of ENTRY_FIELDS) {
    if (target[key] !== resolved[key]) entry[key] = target[key] ?? 0;
  }
  return { kind: 'patch', entry };
}

export function isCustomized(
  resolved: AnomalyDetectorConfigEntry,
  defaults: AnomalyDetectorConfigEntry,
): boolean {
  return ENTRY_FIELDS.some((key) => resolved[key] !== defaults[key]);
}

export function summarize(
  resolved: AnomalyDetectorConfigEntry,
  defaults: AnomalyDetectorConfigEntry,
): Array<{ text: string; customized: boolean }> {
  const differs = (key: keyof AnomalyDetectorConfigEntry) => resolved[key] !== defaults[key];
  const absolute = (label: string, key: AbsoluteKey) => ({
    text: resolved[key] === undefined ? `${label} off` : `${label} >${resolved[key]}`,
    customized: differs(key),
  });
  return [
    {
      text: `z ${resolved.warningZScore} / ${resolved.criticalZScore}`,
      customized: differs('warningZScore') || differs('criticalZScore'),
    },
    absolute('warn', 'warningAbsolute'),
    absolute('crit', 'criticalAbsolute'),
    { text: `${resolved.consecutiveRequired}×`, customized: differs('consecutiveRequired') },
    {
      text: `${(resolved.cooldownMs ?? 0) / 1000}s`,
      customized: differs('cooldownMs'),
    },
  ];
}

export function isDirty(form: DetectorFormState, baseline: DetectorFormState): boolean {
  return JSON.stringify(form) !== JSON.stringify(baseline);
}
