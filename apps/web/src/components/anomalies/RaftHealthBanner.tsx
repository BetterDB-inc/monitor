import { useState } from 'react';
import { AlertOctagon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button';
import { metricsApi } from '@/api/metrics';

export interface RaftHealthEvent {
  id: string;
  timestamp: number;
  metricType: string;
  severity: string;
  message: string;
  resolved?: boolean;
}

const RUNBOOK = [
  'Confirm how many voting nodes are reachable — under Raft the cluster needs a strict majority (e.g. 2 of 3) online to elect a leader and accept writes.',
  'Bring the down nodes back rather than force-promoting: with the pre-vote protocol the term does NOT inflate on quorum loss, so a returning node rejoins cleanly once a majority exists.',
  'Do NOT reset or wipe surviving nodes to "unstick" the cluster — the committed Raft log on the majority is the source of truth; discarding it risks losing acknowledged writes.',
  'If a node is permanently lost, replace it and let it join as a fresh voter so quorum is restored to full strength.',
];

/**
 * Critical banner shown when the Raft-based cluster (Cluster V2) has lost quorum
 * — `cluster_state:fail` with no node reporting `role:leader`. In this state the
 * commit index is frozen and writes are refused until a majority is restored.
 * See the upstream Cluster V2 work (`cluster-protocol raft`).
 */
export function RaftHealthBanner({ events }: { events: RaftHealthEvent[] | undefined }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const active = (events ?? []).filter(
    (e) =>
      e.metricType === 'raft_health' &&
      e.severity === 'critical' &&
      !e.resolved &&
      !dismissed.has(e.id),
  );

  if (active.length === 0) return null;

  const dismiss = async (id: string) => {
    // Only hide the banner once the server has actually resolved the event, so a
    // live quorum-loss alert can't be silently swiped away while still active.
    try {
      const { success } = await metricsApi.resolveAnomalyEvent(id);
      if (!success) return;
    } catch {
      return;
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
          <AlertTitle>Raft cluster has lost quorum</AlertTitle>
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
