import type { ReactElement } from 'react';
import type { AnomalyDetectorMetric, AnomalyDetectorSettingsResponse } from '@betterdb/shared';
import { Badge } from '../../../ui/badge';
import { METRIC_META } from './metric-meta';
import {
  FIELD_SPECS,
  defaultLabel,
  fieldSource,
  hasOverride,
  toDraft,
  type FieldErrors,
  type MetricDraft,
  type ThresholdField,
} from './threshold-form';

interface MetricThresholdRowProps {
  metric: AnomalyDetectorMetric;
  data: AnomalyDetectorSettingsResponse;
  draft: MetricDraft;
  errors: FieldErrors;
  busy: boolean;
  onChange: (metric: AnomalyDetectorMetric, field: ThresholdField, value: string) => void;
  onReset: (metric: AnomalyDetectorMetric) => void;
}

export function MetricThresholdRow({
  metric,
  data,
  draft,
  errors,
  busy,
  onChange,
  onReset,
}: MetricThresholdRowProps): ReactElement {
  const meta = METRIC_META[metric];
  const saved = toDraft(data.resolved[metric]);
  const overridden = hasOverride(data, metric);

  return (
    <tr className="border-b align-top">
      <td className="py-3 pr-4 min-w-[10rem]">
        <div className="flex items-center gap-2">
          <span className="font-bold">{meta.label}</span>
          {overridden && <Badge variant="secondary">Overridden</Badge>}
        </div>
        <div className="text-xs text-muted-foreground">{meta.description}</div>
      </td>
      {FIELD_SPECS.map((spec) => {
        const error = errors[spec.field];
        const source = fieldSource(data, metric, spec.field);
        const changed = draft[spec.field] !== saved[spec.field];
        return (
          <td
            key={spec.field}
            className={`py-3 px-2 min-w-[7.5rem] ${changed ? 'bg-primary/5' : ''}`}
          >
            <input
              type="number"
              inputMode="decimal"
              step={spec.step}
              min={spec.min}
              max={spec.max}
              value={draft[spec.field]}
              placeholder={spec.absolute ? 'off' : undefined}
              aria-label={`${meta.label} ${spec.label}`}
              aria-invalid={error !== undefined ? 'true' : undefined}
              disabled={busy}
              onChange={(event) => {
                onChange(metric, spec.field, event.target.value);
              }}
              className={`w-full px-2 py-1 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 ${
                error !== undefined ? 'border-destructive' : ''
              }`}
            />
            <div className="text-xs text-muted-foreground mt-1">
              {`Default: ${defaultLabel(data, metric, spec.field)}`}
              {spec.absolute && ` ${meta.absoluteUnit}`}
              {source === 'override' && ' · overridden'}
              {source === 'override-off' && ' · off (override)'}
            </div>
            {error !== undefined && <p className="text-xs text-destructive mt-1">{error}</p>}
          </td>
        );
      })}
      <td className="py-3 pl-2">
        <button
          type="button"
          aria-label={`Reset ${meta.label} to defaults`}
          disabled={!overridden || busy}
          onClick={() => {
            onReset(metric);
          }}
          className="px-3 py-1 text-sm border rounded-md hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Reset
        </button>
      </td>
    </tr>
  );
}
