export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
}

export interface OtlpKeyValue {
  key: string;
  value?: OtlpAnyValue;
}

export interface OtlpNumberDataPoint {
  attributes?: OtlpKeyValue[];
  startTimeUnixNano?: string | number;
  timeUnixNano?: string | number;
  asDouble?: number | string;
  asInt?: string | number;
  flags?: number;
}

export interface OtlpMetric {
  name?: string;
  unit?: string;
  gauge?: { dataPoints?: OtlpNumberDataPoint[] };
  sum?: {
    dataPoints?: OtlpNumberDataPoint[];
    aggregationTemporality?: number | string;
    isMonotonic?: boolean;
  };
  histogram?: { dataPoints?: unknown[] };
  exponentialHistogram?: { dataPoints?: unknown[] };
  summary?: { dataPoints?: unknown[] };
}

export interface OtlpScopeMetrics {
  metrics?: OtlpMetric[];
}

export interface OtlpResourceMetrics {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeMetrics?: OtlpScopeMetrics[];
}

export interface OtlpMetricsRequest {
  resourceMetrics?: OtlpResourceMetrics[];
}

export type InfoTarget =
  | { kind: 'scalar'; section: string; field: string }
  | { kind: 'composite'; section: 'keyspace' | 'commandstats'; field: string; subkey: string };

export interface FieldUpdate {
  target: InfoTarget;
  value: string;
  timeMs: number;
}

export const DROP_REASONS = [
  'unidentified',
  'unknown_instance',
  'already_polled',
  'unsupported_type',
  'unsupported_temporality',
  'unmapped_metric',
  'cardinality_limit',
] as const;

export type DropReason = (typeof DROP_REASONS)[number];

export interface InstanceKey {
  host: string;
  port: number;
}

export interface PartialSuccess {
  rejectedDataPoints: number;
  errorMessage: string;
}
