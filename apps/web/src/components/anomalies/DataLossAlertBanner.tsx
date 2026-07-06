import { useState } from 'react';
import { AlertOctagon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button';
import { metricsApi } from '@/api/metrics';

export interface DataLossEvent {
  id: string;
  timestamp: number;
  metricType: string;
  severity: string;
  message: string;
  resolved?: boolean;
}

const RUNBOOK = [
  'Detach surviving replicas NOW with REPLICAOF NO ONE — any replica that full-resyncs from the empty primary will be wiped.',
  'Stop client writes to the affected primary so new data does not mix with a partial restore.',
  'Restore the dataset from a backup (RDB/AOF) or promote a detached replica that still holds the data.',
  'Enable persistence on the primary before reattaching replicas (see Valkey docs: "Safety of replication when master has persistence turned off").',
];

/**
 * Critical banner shown when a data-loss event (primary restarted empty /
 * replica wiped by full resync) is active. See valkey/valkey#579.
 */
export function DataLossAlertBanner({ events }: { events: DataLossEvent[] | undefined }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const active = (events ?? []).filter(
    (e) =>
      e.metricType === 'dataset_keys' &&
      e.severity === 'critical' &&
      !e.resolved &&
      !dismissed.has(e.id),
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
        <Alert key={event.id} variant="destructive" className="border-destructive">
          <AlertOctagon className="w-4 h-4" />
          <AlertTitle>Data loss detected</AlertTitle>
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
