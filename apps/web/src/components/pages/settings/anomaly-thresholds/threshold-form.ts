import type {
  AnomalyDetectorConfigEntry,
  AnomalyDetectorMetric,
  AnomalyDetectorSettingsResponse,
} from '@betterdb/shared';
import type { AnomalyDetectorUpdateRequest } from '../../../../api/anomaly-detectors';
import { METRIC_ORDER } from './metric-meta';

export type ThresholdField = keyof Required<AnomalyDetectorConfigEntry>;

export interface FieldSpec {
  field: ThresholdField;
  label: string;
  min: number;
  max?: number;
  integer: boolean;
  /** Absolute thresholds: empty (or 0) means "off". */
  absolute: boolean;
  step: string;
}

// Mirrors DetectorConfigDto (apps/api/src/settings/dto/update-anomaly-detectors.dto.ts).
// Keep the bounds in sync with that file.
export const FIELD_SPECS: readonly FieldSpec[] = [
  {
    field: 'warningZScore',
    label: 'Warning z-score',
    min: 0.5,
    max: 10,
    integer: false,
    absolute: false,
    step: '0.1',
  },
  {
    field: 'criticalZScore',
    label: 'Critical z-score',
    min: 1,
    max: 15,
    integer: false,
    absolute: false,
    step: '0.1',
  },
  {
    field: 'warningAbsolute',
    label: 'Warning absolute',
    min: 0,
    integer: false,
    absolute: true,
    step: 'any',
  },
  {
    field: 'criticalAbsolute',
    label: 'Critical absolute',
    min: 0,
    integer: false,
    absolute: true,
    step: 'any',
  },
  {
    field: 'consecutiveRequired',
    label: 'Consecutive samples',
    min: 1,
    max: 20,
    integer: true,
    absolute: false,
    step: '1',
  },
  {
    field: 'cooldownMs',
    label: 'Cooldown (ms)',
    min: 1000,
    max: 3_600_000,
    integer: true,
    absolute: false,
    step: '1000',
  },
];

export type MetricDraft = Record<ThresholdField, string>;
export type Drafts = Record<AnomalyDetectorMetric, MetricDraft>;
export type FieldErrors = Partial<Record<ThresholdField, string>>;

/** Draft text for one metric, from its resolved (defaults + overrides) config.
 *  A disabled absolute threshold is omitted from `resolved`, so it becomes ''. */
export function toDraft(resolved: AnomalyDetectorConfigEntry | undefined): MetricDraft {
  const out = {} as MetricDraft;
  for (const { field } of FIELD_SPECS) {
    const v = resolved?.[field];
    out[field] = typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
  }
  return out;
}

export function draftsFrom(data: AnomalyDetectorSettingsResponse): Drafts {
  const out = {} as Drafts;
  for (const m of METRIC_ORDER) out[m] = toDraft(data.resolved[m]);
  return out;
}

/** Parsed draft value: a finite number, null for "off/empty", or NaN for unparseable text. */
function parseDraft(raw: string, spec: FieldSpec): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return Number.NaN;
  // 0 is the API's "disabled" value for absolutes; treat it the same as empty.
  if (spec.absolute && n === 0) return null;
  return n;
}

export function validateMetricDraft(draft: MetricDraft): FieldErrors {
  const errors: FieldErrors = {};
  const values: Partial<Record<ThresholdField, number>> = {};

  for (const spec of FIELD_SPECS) {
    const v = parseDraft(draft[spec.field], spec);
    if (v === null) {
      if (!spec.absolute) errors[spec.field] = 'Required — use Reset to return to the default';
      continue;
    }
    if (Number.isNaN(v)) {
      errors[spec.field] = 'Enter a number';
      continue;
    }
    if (spec.integer && !Number.isInteger(v)) {
      errors[spec.field] = 'Enter a whole number';
      continue;
    }
    if (v < spec.min || (spec.max !== undefined && v > spec.max)) {
      errors[spec.field] =
        spec.max !== undefined
          ? `Must be between ${spec.min} and ${spec.max}`
          : `Must be ${spec.min} or more`;
      continue;
    }
    values[spec.field] = v;
  }

  // Cross-field rules, applied to the full merged values (same as the server's merged check).
  if (
    values.warningZScore !== undefined &&
    values.criticalZScore !== undefined &&
    values.warningZScore >= values.criticalZScore &&
    !errors.criticalZScore
  ) {
    errors.criticalZScore = 'Must be greater than the warning z-score';
  }
  if (
    values.warningAbsolute !== undefined &&
    values.criticalAbsolute !== undefined &&
    values.warningAbsolute >= values.criticalAbsolute &&
    !errors.criticalAbsolute
  ) {
    errors.criticalAbsolute = 'Must be greater than the warning absolute threshold';
  }
  return errors;
}

function currentValue(raw: number | undefined, spec: FieldSpec): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return spec.absolute && raw === 0 ? null : raw;
}

/** Minimal PATCH body: only fields whose draft differs from `resolved`. */
export function buildPatch(
  drafts: Drafts,
  data: AnomalyDetectorSettingsResponse,
): AnomalyDetectorUpdateRequest {
  const patch: AnomalyDetectorUpdateRequest = {};
  for (const metric of METRIC_ORDER) {
    const resolved = data.resolved[metric] ?? {};
    const entry: AnomalyDetectorConfigEntry = {};
    for (const spec of FIELD_SPECS) {
      const next = parseDraft(drafts[metric][spec.field], spec);
      const current = currentValue(resolved[spec.field], spec);
      if (next === current || Number.isNaN(next)) continue;
      if (next === null) {
        // Only absolutes can be emptied (validation blocks the others): send 0 = disable.
        if (spec.absolute) entry[spec.field] = 0;
        continue;
      }
      entry[spec.field] = next;
    }
    if (Object.keys(entry).length > 0) patch[metric] = entry;
  }
  return patch;
}

export type FieldSource = 'default' | 'override' | 'override-off';

export function fieldSource(
  data: AnomalyDetectorSettingsResponse,
  metric: AnomalyDetectorMetric,
  field: ThresholdField,
): FieldSource {
  const v = data.overrides[metric]?.[field];
  if (v === undefined) return 'default';
  return FIELD_SPECS.find((s) => s.field === field)?.absolute && v === 0
    ? 'override-off'
    : 'override';
}

/** "2.5", or "off" for an absolute threshold with no default. */
export function defaultLabel(
  data: AnomalyDetectorSettingsResponse,
  metric: AnomalyDetectorMetric,
  field: ThresholdField,
): string {
  const v = data.defaults[metric]?.[field];
  return typeof v === 'number' ? v.toLocaleString() : 'off';
}

export function hasOverride(
  data: AnomalyDetectorSettingsResponse,
  metric: AnomalyDetectorMetric,
): boolean {
  return Object.keys(data.overrides[metric] ?? {}).length > 0;
}
