import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ANOMALY_DETECTOR_METRICS,
  Feature,
  type AnomalyDetectorMetric,
} from '@betterdb/shared';
import { settingsApi } from '../../../../api/settings';
import { useLicense } from '../../../../hooks/useLicense';
import { Alert, AlertDescription, AlertTitle } from '../../../ui/alert';
import { Badge } from '../../../ui/badge';
import { Button } from '../../../ui/button';
import { DetectorPanel } from './DetectorPanel';
import { ANOMALY_DETECTORS_QUERY_KEY } from './detector-form';

function isDetectorMetric(value: string | null): value is AnomalyDetectorMetric {
  return value !== null && (ANOMALY_DETECTOR_METRICS as readonly string[]).includes(value);
}

export function DetectorThresholds() {
  const { hasFeature, tier } = useLicense();
  const licensed = hasFeature(Feature.ANOMALY_DETECTION);
  const [searchParams] = useSearchParams();
  const linkedParam = searchParams.get('metric');
  const linkedMetric = isDetectorMetric(linkedParam) ? linkedParam : null;
  const queryClient = useQueryClient();
  const scrolled = useRef(false);
  const [openMetrics, setOpenMetrics] = useState<Set<AnomalyDetectorMetric>>(
    () => new Set(linkedMetric ? [linkedMetric] : []),
  );
  const [resetError, setResetError] = useState<string | null>(null);

  const { data, error, isLoading } = useQuery({
    queryKey: ANOMALY_DETECTORS_QUERY_KEY,
    queryFn: () => settingsApi.getAnomalyDetectors(),
    enabled: licensed,
  });

  const resetAll = useMutation({
    mutationFn: () => settingsApi.resetAllAnomalyDetectors(),
    onSuccess: () => {
      setResetError(null);
      queryClient.invalidateQueries({ queryKey: ANOMALY_DETECTORS_QUERY_KEY });
    },
    onError: (err) => setResetError(err instanceof Error ? err.message : 'Failed to reset'),
  });

  useEffect(() => {
    if (!data || !linkedMetric || scrolled.current) return;
    scrolled.current = true;
    document
      .getElementById(`detector-${linkedMetric}`)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [data, linkedMetric]);

  const setOpen = (metric: AnomalyDetectorMetric, open: boolean) =>
    setOpenMetrics((current) => {
      const next = new Set(current);
      if (open) next.add(metric);
      else next.delete(metric);
      return next;
    });

  const handleResetAll = () => {
    if (!window.confirm('Reset all detector thresholds to their defaults?')) return;
    resetAll.mutate();
  };

  return (
    <div className="space-y-3 pt-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold">Detector thresholds</h3>
          <p className="text-sm text-muted-foreground">
            Per-metric spike detection thresholds. Changes apply immediately.
          </p>
        </div>
        {licensed && (
          <Button
            size="sm"
            variant="outline"
            disabled={!data || Object.keys(data.overrides).length === 0 || resetAll.isPending}
            onClick={handleResetAll}
          >
            Reset all to defaults
          </Button>
        )}
      </div>

      {!licensed ? (
        <Alert>
          <AlertTitle>
            Pro feature
            <Badge variant="secondary" className="ml-2">
              {tier}
            </Badge>
          </AlertTitle>
          <AlertDescription>Per-metric detector thresholds require a Pro license.</AlertDescription>
        </Alert>
      ) : error ? (
        <p className="text-sm text-destructive">
          Failed to load detector thresholds: {error instanceof Error ? error.message : 'unknown error'}
        </p>
      ) : isLoading || !data ? (
        <p className="text-sm text-muted-foreground">Loading detector thresholds…</p>
      ) : (
        <div className="rounded-lg border border-border">
          {ANOMALY_DETECTOR_METRICS.map((metric) => (
            <DetectorPanel
              key={metric}
              metric={metric}
              defaults={data.defaults[metric]}
              resolved={data.resolved[metric]}
              hasOverride={data.overrides[metric] !== undefined}
              open={openMetrics.has(metric)}
              onOpenChange={(open) => setOpen(metric, open)}
            />
          ))}
        </div>
      )}
      {resetError && <p className="text-sm text-destructive">{resetError}</p>}
    </div>
  );
}
