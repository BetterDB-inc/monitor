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

export function planInstruments(metrics: PromMetricJson[]): InstrumentSpec[] {
  const specs: InstrumentSpec[] = [];
  for (const metric of metrics) {
    const kind = toMirrorKind(metric.type);
    if (!kind) {
      continue;
    }
    specs.push({ name: metric.name, kind, description: metric.help ?? '' });
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
