import { useId, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import type {
  AnomalyDetectorConfigEntry,
  AnomalyDetectorMetric,
  AnomalyDetectorSettingsResponse,
} from '@betterdb/shared';
import { settingsApi } from '../../../../api/settings';
import { Alert, AlertDescription } from '../../../ui/alert';
import { Badge } from '../../../ui/badge';
import { Button } from '../../../ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../../ui/collapsible';
import { Input } from '../../../ui/input';
import { Switch } from '../../../ui/switch';
import { cn } from '../../../../lib/utils';
import {
  ANOMALY_DETECTORS_QUERY_KEY,
  LIFETIME_COUNTER_METRICS,
  METRIC_UNITS,
  buildSave,
  isCustomized,
  isDirty,
  summarize,
  toFormState,
  validateForm,
  type AbsoluteField,
  type DetectorFormState,
  type DetectorSave,
} from './detector-form';

interface DetectorPanelProps {
  metric: AnomalyDetectorMetric;
  defaults: AnomalyDetectorConfigEntry;
  resolved: AnomalyDetectorConfigEntry;
  hasOverride: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type TextField = 'warningZScore' | 'criticalZScore' | 'consecutiveRequired' | 'cooldownSeconds';
type AbsoluteKey = 'warningAbsolute' | 'criticalAbsolute';

function expectedResolved(
  save: DetectorSave,
  defaults: AnomalyDetectorConfigEntry,
  resolved: AnomalyDetectorConfigEntry,
) {
  if (save.kind === 'reset') return defaults;
  const next: AnomalyDetectorConfigEntry = { ...resolved, ...save.entry };
  if (!next.warningAbsolute) delete next.warningAbsolute;
  if (!next.criticalAbsolute) delete next.criticalAbsolute;
  return next;
}

function FieldHints({ differsFrom, range, error }: { differsFrom?: string; range: string; error?: string }) {
  return (
    <div className="mt-1 flex flex-col text-xs">
      {differsFrom !== undefined && <span className="text-muted-foreground">default {differsFrom}</span>}
      <span className="text-muted-foreground">{range}</span>
      {error && <span className="text-destructive">{error}</span>}
    </div>
  );
}

export function DetectorPanel({
  metric,
  defaults,
  resolved,
  hasOverride,
  open,
  onOpenChange,
}: DetectorPanelProps) {
  const queryClient = useQueryClient();
  const idPrefix = useId();
  const baseline = useMemo(() => toFormState(resolved, defaults), [resolved, defaults]);
  const [form, setForm] = useState<DetectorFormState>(baseline);
  const [prevBaseline, setPrevBaseline] = useState<DetectorFormState>(baseline);
  const [error, setError] = useState<string | null>(null);

  if (isDirty(baseline, prevBaseline)) {
    setPrevBaseline(baseline);
    if (!isDirty(form, prevBaseline)) setForm(baseline);
  }

  const dirty = isDirty(form, baseline);
  const errors = validateForm(form, defaults);
  const hasErrors = Object.keys(errors).length > 0;
  const customized = isCustomized(resolved, defaults);
  const summary = summarize(resolved, defaults);

  const mutation = useMutation({
    mutationFn: ({
      save,
    }: {
      save: DetectorSave;
      submitted: DetectorFormState;
      base: AnomalyDetectorConfigEntry;
    }) =>
      save.kind === 'reset'
        ? settingsApi.resetAnomalyDetector(metric)
        : settingsApi.updateAnomalyDetectors({ [metric]: save.entry }),
    onSuccess: (_data, { save, submitted, base }) => {
      setError(null);
      const next = expectedResolved(save, defaults, base);
      queryClient.setQueryData<AnomalyDetectorSettingsResponse>(ANOMALY_DETECTORS_QUERY_KEY, (prev) => {
        if (!prev) return prev;
        const overrides = { ...prev.overrides };
        if (save.kind === 'reset') delete overrides[metric];
        else overrides[metric] = { ...overrides[metric], ...save.entry };
        return { ...prev, overrides, resolved: { ...prev.resolved, [metric]: next } };
      });
      setForm((current) => (isDirty(current, submitted) ? current : toFormState(next, defaults)));
      queryClient.invalidateQueries({ queryKey: ANOMALY_DETECTORS_QUERY_KEY });
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save'),
  });

  const setText = (key: TextField, value: string) => {
    setError(null);
    setForm((f) => ({ ...f, [key]: value }));
  };
  const setAbsolute = (key: AbsoluteKey, patch: Partial<AbsoluteField>) => {
    setError(null);
    setForm((f) => ({ ...f, [key]: { ...f[key], ...patch } }));
  };

  const defaultText = (key: TextField): string => {
    if (key === 'cooldownSeconds') {
      return defaults.cooldownMs === undefined ? '' : String(defaults.cooldownMs / 1000);
    }
    const value = defaults[key];
    return value === undefined ? '' : String(value);
  };

  const textField = (key: TextField, label: string, range: string, step: string) => {
    const id = `${idPrefix}-${key}`;
    return (
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <Input
          id={id}
          type="number"
          step={step}
          value={form[key]}
          placeholder={defaultText(key)}
          aria-invalid={errors[key] ? true : undefined}
          onChange={(e) => setText(key, e.target.value)}
          className="mt-1"
        />
        <FieldHints
          differsFrom={form[key].trim() !== '' && form[key] !== defaultText(key) ? defaultText(key) : undefined}
          range={range}
          error={errors[key]}
        />
      </div>
    );
  };

  const absoluteField = (key: AbsoluteKey, label: string) => {
    const id = `${idPrefix}-${key}`;
    const field = form[key];
    const defaultValue = defaults[key];
    const defaultLabel = defaultValue === undefined ? 'off' : String(defaultValue);
    const differs =
      field.enabled !== (defaultValue !== undefined) ||
      (field.enabled && field.value.trim() !== '' && field.value !== String(defaultValue));
    return (
      <div>
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={id} className="text-sm font-medium">
            {label}
          </label>
          <Switch
            size="sm"
            checked={field.enabled}
            aria-label={`${label} enabled`}
            onCheckedChange={(checked) => setAbsolute(key, { enabled: checked })}
          />
        </div>
        <Input
          id={id}
          type="number"
          step="any"
          value={field.value}
          disabled={!field.enabled}
          placeholder={field.enabled ? (defaultValue === undefined ? '' : String(defaultValue)) : 'off'}
          aria-invalid={errors[key] ? true : undefined}
          onChange={(e) => setAbsolute(key, { value: e.target.value })}
          className="mt-1"
        />
        <FieldHints differsFrom={differs ? defaultLabel : undefined} range="> 0" error={errors[key]} />
      </div>
    );
  };

  return (
    <Collapsible
      id={`detector-${metric}`}
      open={open}
      onOpenChange={onOpenChange}
      className="border-b border-border last:border-b-0"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/50">
        <span
          data-testid="customized-dot"
          data-customized={String(customized)}
          className={cn(
            'size-2.5 shrink-0 rounded-full',
            customized
              ? 'bg-primary shadow-[0_0_6px_2px] shadow-primary/60'
              : 'border border-muted-foreground',
          )}
        />
        <span className="font-mono text-sm">{metric}</span>
        {dirty && (
          <Badge variant="outline" className="text-xs">
            Unsaved
          </Badge>
        )}
        <span className="ml-auto flex flex-wrap justify-end gap-x-1 text-xs">
          {summary.map((segment, i) => (
            <span key={i} className="flex gap-x-1">
              {i > 0 && <span className="text-muted-foreground">·</span>}
              <span className={segment.customized ? 'font-semibold' : 'text-muted-foreground'}>
                {segment.text}
              </span>
            </span>
          ))}
        </span>
        <ChevronDown
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 px-3 pb-4 pt-2">
        <p className="text-sm text-muted-foreground">Unit: {METRIC_UNITS[metric]}</p>
        {LIFETIME_COUNTER_METRICS.has(metric) && (
          <Alert>
            <AlertDescription>
              This metric is a lifetime total since the server's last restart. Once it passes an
              absolute threshold it alerts every cooldown until the server restarts.
            </AlertDescription>
          </Alert>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {textField('warningZScore', 'Warning z-score', '0.5–10', '0.1')}
          {textField('criticalZScore', 'Critical z-score', '1–15, above warning', '0.1')}
          {absoluteField('warningAbsolute', 'Warning above')}
          {absoluteField('criticalAbsolute', 'Critical above')}
          {textField('consecutiveRequired', 'Consecutive breaches', '1–20', '1')}
          {textField('cooldownSeconds', 'Cooldown (seconds)', '1–3600', '1')}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!dirty || hasErrors || mutation.isPending}
            onClick={() =>
              mutation.mutate({ save: buildSave(form, defaults, resolved), submitted: form, base: resolved })
            }
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!hasOverride || mutation.isPending}
            onClick={() => mutation.mutate({ save: { kind: 'reset' }, submitted: form, base: resolved })}
          >
            Reset to defaults
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
