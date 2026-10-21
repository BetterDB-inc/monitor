import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Feature, type AnomalyDetectorMetric } from '@betterdb/shared';
import { anomalyDetectorsApi } from '../../../../api/anomaly-detectors';
import { PaymentRequiredError } from '../../../../api/client';
import { useAnomalyDetectorSettings } from '../../../../hooks/useAnomalyDetectorSettings';
import { useLicense } from '../../../../hooks/useLicense';
import { Skeleton } from '../../../ui/skeleton';
import { MetricThresholdRow } from './MetricThresholdRow';
import { METRIC_META, METRIC_ORDER } from './metric-meta';
import {
  FIELD_SPECS,
  buildPatch,
  draftsFrom,
  hasOverride,
  toDraft,
  validateMetricDraft,
  type Drafts,
  type FieldErrors,
  type ThresholdField,
} from './threshold-form';

const RESET_ALL_CONFIRM =
  'Reset every anomaly detector threshold to its default? Stored overrides are removed.';

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.message;
  }
  return fallback;
}

function LicenseGate(): ReactElement {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold mb-4">Anomaly Thresholds</h2>
      <p className="text-sm text-muted-foreground">
        Per-metric thresholds are part of Anomaly Detection, available on Pro and Enterprise.{' '}
        <a href="?section=license" className="text-primary hover:underline">
          View license
        </a>
      </p>
    </div>
  );
}

export function AnomalyThresholdsPanel(): ReactElement {
  const { hasFeature } = useLicense();
  const licensed = hasFeature(Feature.ANOMALY_DETECTION);
  const { data, loading, error, invalidate } = useAnomalyDetectorSettings(licensed);
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Set while a per-metric reset is refetching, so only that metric's draft is
  // replaced and unsaved edits to other metrics survive.
  const pendingResetMetric = useRef<AnomalyDetectorMetric | null>(null);

  useEffect(() => {
    if (!data) return;
    const resetMetric = pendingResetMetric.current;
    pendingResetMetric.current = null;
    setDrafts((prev) => {
      if (resetMetric === null || prev === null) return draftsFrom(data);
      return { ...prev, [resetMetric]: toDraft(data.resolved[resetMetric]) };
    });
  }, [data]);

  if (!licensed || error instanceof PaymentRequiredError) {
    return <LicenseGate />;
  }

  if (error !== null) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold mb-4">Anomaly Thresholds</h2>
        <div
          role="alert"
          className="text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-2"
        >
          {error.message}
        </div>
        <button
          type="button"
          onClick={() => {
            void invalidate();
          }}
          className="px-4 py-2 text-sm border rounded-md hover:bg-muted"
        >
          Retry
        </button>
      </div>
    );
  }

  if (loading || !data || !drafts) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold mb-4">Anomaly Thresholds</h2>
        <Skeleton className="h-64 w-full" />
        <span className="sr-only">Loading thresholds…</span>
      </div>
    );
  }

  const errorsByMetric = Object.fromEntries(
    METRIC_ORDER.map((metric) => [metric, validateMetricDraft(drafts[metric])]),
  ) as Record<AnomalyDetectorMetric, FieldErrors>;
  const hasErrors = Object.values(errorsByMetric).some((e) => Object.keys(e).length > 0);
  const patch = buildPatch(drafts, data);
  const dirty = Object.keys(patch).length > 0;
  const anyOverride = METRIC_ORDER.some((metric) => hasOverride(data, metric));

  const clearMessages = (): void => {
    setSaveError(null);
    setNotice(null);
  };

  const handleChange = (
    metric: AnomalyDetectorMetric,
    field: ThresholdField,
    value: string,
  ): void => {
    setDrafts((prev) => (prev ? { ...prev, [metric]: { ...prev[metric], [field]: value } } : prev));
  };

  const handleSave = async (): Promise<void> => {
    if (!dirty || hasErrors || busy) return;
    setBusy(true);
    clearMessages();
    try {
      const response = await anomalyDetectorsApi.update(patch);
      pendingResetMetric.current = null;
      await invalidate();
      setNotice(response.message);
    } catch (err) {
      setSaveError(errorMessage(err, 'Failed to save thresholds'));
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = (): void => {
    setDrafts(draftsFrom(data));
    clearMessages();
  };

  const handleResetMetric = async (metric: AnomalyDetectorMetric): Promise<void> => {
    setBusy(true);
    clearMessages();
    pendingResetMetric.current = metric;
    try {
      const response = await anomalyDetectorsApi.clearMetric(metric);
      await invalidate();
      setNotice(response.message);
    } catch (err) {
      pendingResetMetric.current = null;
      setSaveError(errorMessage(err, `Failed to reset ${METRIC_META[metric].label}`));
    } finally {
      setBusy(false);
    }
  };

  const handleResetAll = async (): Promise<void> => {
    if (!confirm(RESET_ALL_CONFIRM)) return;
    setBusy(true);
    clearMessages();
    pendingResetMetric.current = null;
    try {
      const response = await anomalyDetectorsApi.resetAll();
      await invalidate();
      setNotice(response.message);
    } catch (err) {
      setSaveError(errorMessage(err, 'Failed to reset thresholds'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold mb-4">Anomaly Thresholds</h2>
      <p className="text-sm text-muted-foreground">
        Tune when each metric raises WARNING and CRITICAL anomalies. Changes apply to running
        detectors immediately; in multi-replica deployments other replicas pick them up within 30
        seconds. Leave an absolute threshold empty to turn it off.
      </p>

      {saveError !== null && (
        <div
          role="alert"
          className="text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-2"
        >
          {saveError}
        </div>
      )}
      {notice !== null && (
        <div
          role="status"
          className="text-sm text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-md p-2"
        >
          {notice}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Metric</th>
              {FIELD_SPECS.map((spec) => (
                <th key={spec.field} className="py-2 px-2 font-medium">
                  {spec.label}
                </th>
              ))}
              <th className="py-2 pl-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {METRIC_ORDER.map((metric) => (
              <MetricThresholdRow
                key={metric}
                metric={metric}
                data={data}
                draft={drafts[metric]}
                errors={errorsByMetric[metric]}
                busy={busy}
                onChange={handleChange}
                onReset={(m) => {
                  void handleResetMetric(m);
                }}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3 mt-6 pt-6 border-t">
        <button
          type="button"
          onClick={() => {
            void handleSave();
          }}
          disabled={!dirty || hasErrors || busy}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
        >
          {busy ? 'Saving...' : 'Save thresholds'}
        </button>
        <button
          type="button"
          onClick={handleDiscard}
          disabled={(!dirty && !hasErrors) || busy}
          className="px-4 py-2 border rounded-md hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Discard
        </button>
        <button
          type="button"
          onClick={() => {
            void handleResetAll();
          }}
          disabled={!anyOverride || busy}
          className="ml-auto px-4 py-2 text-destructive border border-destructive rounded-md hover:bg-destructive/10 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Reset all
        </button>
      </div>
    </div>
  );
}
