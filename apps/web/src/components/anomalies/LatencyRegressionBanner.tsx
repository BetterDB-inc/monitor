import { useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button';
import { metricsApi } from '@/api/metrics';

export interface LatencyRegressionEvent {
  id: string;
  timestamp: number;
  metricType: string;
  severity: string;
  message: string;
  resolved?: boolean;
}

const RUNBOOK = [
  'Compare per-command P99 before/after the change via the latencystats history API.',
  'On Valkey 9+, tune prefetch-batch-max-size (default 16): try 4, or 0 to disable batched prefetching (valkey PR #2092).',
  'Split multi-thousand-command pipelines into smaller batches on the client side.',
  'If P99 spikes recur hourly, check the client cluster topology refresh interval.',
  'After an upgrade, consider holding the rollout; track valkey/valkey#3527 and #3451 for upstream fixes.',
];

/**
 * Banner shown when a per-command P99 latency regression is active
 * (post-upgrade or sustained). See valkey/valkey#3527.
 */
export function LatencyRegressionBanner({
  events,
}: {
  events: LatencyRegressionEvent[] | undefined;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const active = (events ?? []).filter(
    (e) => e.metricType === 'command_p99' && !e.resolved && !dismissed.has(e.id),
  );

  if (active.length === 0) return null;

  const dismiss = async (id: string) => {
    try {
      await metricsApi.resolveAnomalyEvent(id);
    } catch {
      // Still hide locally; the event remains in the anomaly feed.
    }
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-2">
      {active.map((event) => (
        <Alert
          key={event.id}
          variant={event.severity === 'critical' ? 'destructive' : 'default'}
          className={event.severity === 'critical' ? 'border-destructive' : undefined}
        >
          <TrendingUp className="w-4 h-4" />
          <AlertTitle>P99 latency regression detected</AlertTitle>
          <AlertDescription>
            <p className="font-medium">{event.message}</p>
            <div className="mt-2">
              <p className="font-semibold">Remediation runbook</p>
              <ol className="list-decimal pl-4 space-y-1 mt-1">
                {RUNBOOK.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            </div>
            <div className="mt-2">
              <Button size="sm" variant="outline" onClick={() => dismiss(event.id)}>
                Mark resolved
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}
