import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button';
import { metricsApi } from '@/api/metrics';

export interface ReplicaSlotStateEvent {
  id: string;
  timestamp: number;
  metricType: string;
  severity: string;
  message: string;
  resolved?: boolean;
}

const RUNBOOK = [
  'A replica must never carry slot migrating/importing state or own slots — this is a stuck, inconsistent cluster state (valkey#1664) that does not self-heal.',
  'Apply the exact remediation in the alert above, which depends on the symptom: for a replica reporting slots in migrating/importing state, run `CLUSTER SETSLOT <slot> STABLE` on that replica for each affected slot; for a replica that owns slots (ownership divergence), re-attach it with `CLUSTER REPLICATE <primary-id>` instead — do NOT run SETSLOT STABLE for that case.',
  'Do NOT blindly force a failover or reset the node to "unstick" it — apply the targeted fix for the reported symptom.',
  'Confirm recovery: the replica should report no migrating/importing slots (and no owned slots) in CLUSTER NODES, and this alert will resolve on the next poll.',
];

/**
 * Warning banner shown when a cluster replica is wrongly reporting slot
 * migrating/importing/owned state — the stuck condition behind
 * valkey-io/valkey#1664. Surfaces an otherwise-silent inconsistency and the
 * `CLUSTER SETSLOT ... STABLE` remediation.
 */
export function ReplicaSlotStateBanner({
  events,
}: {
  events: ReplicaSlotStateEvent[] | undefined;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const active = (events ?? []).filter(
    (e) => e.metricType === 'replica_slot_state' && !e.resolved && !dismissed.has(e.id),
  );

  if (active.length === 0) return null;

  const dismiss = async (id: string) => {
    // Only hide once the server has actually resolved the event, so a live stuck
    // state can't be silently swiped away while still active.
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
        <Alert key={event.id} className="border-yellow-500 text-yellow-500">
          <AlertTriangle className="w-4 h-4" />
          <AlertTitle>Replica slot-state inconsistency (valkey#1664)</AlertTitle>
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
