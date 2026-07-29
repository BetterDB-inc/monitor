/**
 * Pure mapping from a prom-client registry snapshot (getMetricsAsJSON) to the
 * shape the OTel metrics mirror needs. Kept free of the OTel SDK so it can be
 * unit-tested in isolation. Histograms and summaries are skipped: the OTel
 * observable-instrument API records individual values, but prom-client only
 * exposes pre-aggregated buckets, so they cannot be mirrored losslessly here.
 */

export interface PromMetricValue {
  value: number;
  labels?: Record<string, unknown>;
}

export interface PromMetricJson {
  name: string;
  help?: string;
  type: string;
  values: PromMetricValue[];
}

export type MirrorKind = 'gauge' | 'counter';

export interface InstrumentSpec {
  name: string;
  kind: MirrorKind;
  description: string;
  /** UCUM unit derived from the prom-client name suffix, or '' when unknown. */
  unit: string;
}

export interface MirrorDataPoint {
  value: number;
  attributes: Record<string, string | number>;
}

function toMirrorKind(type: string): MirrorKind | null {
  if (type === 'gauge') {
    return 'gauge';
  }
  if (type === 'counter') {
    return 'counter';
  }
  return null;
}

/**
 * Derives a UCUM unit from the prom-client metric-name suffix, following the
 * Prometheus→OTel naming convention. Only unambiguous suffixes are mapped; an
 * unknown suffix yields '' (no unit), which the SDK treats as unset. The '_total'
 * counter suffix carries no unit and is intentionally left blank. Unit lives in
 * OTLP metadata, not the name, so the mirrored name is never rewritten.
 */
export function deriveUnit(name: string): string {
  if (name.endsWith('_bytes')) {
    return 'By';
  }
  if (name.endsWith('_seconds')) {
    return 's';
  }
  if (name.endsWith('_milliseconds')) {
    return 'ms';
  }
  if (name.endsWith('_ratio')) {
    return '1';
  }
  if (name.endsWith('_percent')) {
    return '%';
  }
  return '';
}

export function planInstruments(metrics: PromMetricJson[]): InstrumentSpec[] {
  const specs: InstrumentSpec[] = [];
  for (const metric of metrics) {
    const kind = toMirrorKind(metric.type);
    if (!kind) {
      continue;
    }
    specs.push({
      name: metric.name,
      kind,
      description: metric.help ?? '',
      unit: deriveUnit(metric.name),
    });
  }
  return specs;
}

function toAttributes(
  labels: Record<string, unknown> | undefined,
): Record<string, string | number> {
  const attributes: Record<string, string | number> = {};
  if (!labels) {
    return attributes;
  }
  for (const [key, value] of Object.entries(labels)) {
    if (typeof value === 'string' || typeof value === 'number') {
      attributes[key] = value;
    }
  }
  return attributes;
}

export function collectDataPoints(metric: PromMetricJson): MirrorDataPoint[] {
  const points: MirrorDataPoint[] = [];
  for (const entry of metric.values) {
    if (typeof entry.value !== 'number' || Number.isNaN(entry.value)) {
      continue;
    }
    points.push({ value: entry.value, attributes: toAttributes(entry.labels) });
  }
  return points;
}
