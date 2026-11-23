import { useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { isAdminCommand } from '@betterdb/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { metricsApi } from '@/api/metrics';

export interface LatencyRegressionEvent {
  id: string;
  timestamp: number;
  metricType: string;
  severity: string;
  message: string;
  resolved?: boolean;
  /** Degradation factor of the worst command. */
  threshold?: number;
  /** Regressed commands, as latencystats names. Absent on older events. */
  commands?: string[];
}

const RUNBOOK = [
  'Compare per-command P99 before/after the change via the latencystats history API.',
  'On Valkey 9+, tune prefetch-batch-max-size (default 16): try 4, or 0 to disable batched prefetching (valkey PR #2092).',
  'Split multi-thousand-command pipelines into smaller batches on the client side.',
  'If P99 spikes recur hourly, check the client cluster topology refresh interval.',
  'After an upgrade, consider holding the rollout; track valkey/valkey#3527 and #3451 for upstream fixes.',
];

// Admin and monitoring commands are ignored by the guard unless an operator opts
// them back in. When they do show up, they go after the data commands: an event
// made only of admin commands sorts after the others, and inside an upgrade event
// that mixes both, the admin commands are listed last with the tag. A mixed event
// sorts with the data events, since its data commands need looking at.
function splitCommands(event: LatencyRegressionEvent): { data: string[]; admin: string[] } {
  const commands = event.commands ?? [];
  return {
    data: commands.filter((command) => !isAdminCommand(command)),
    admin: commands.filter(isAdminCommand),
  };
}

function isAdminEvent(event: LatencyRegressionEvent): boolean {
  const { data, admin } = splitCommands(event);
  return data.length === 0 && admin.length > 0;
}

function compareEvents(a: LatencyRegressionEvent, b: LatencyRegressionEvent): number {
  const admin = Number(isAdminEvent(a)) - Number(isAdminEvent(b));
  if (admin !== 0) return admin;
  const critical = Number(b.severity === 'critical') - Number(a.severity === 'critical');
  if (critical !== 0) return critical;
  return (b.threshold ?? 0) - (a.threshold ?? 0);
}

function countCommands(events: LatencyRegressionEvent[]): number {
  const commands = new Set<string>();
  let unnamed = 0;
  for (const event of events) {
    if (event.commands && event.commands.length > 0) {
      for (const command of event.commands) commands.add(command);
    } else {
      unnamed += 1;
    }
  }
  return commands.size + unnamed;
}

/**
 * One banner for every active per-command P99 latency regression (post-upgrade or
 * sustained), one line per event. See valkey/valkey#3527.
 */
export function LatencyRegressionBanner({
  events,
}: {
  events: LatencyRegressionEvent[] | undefined;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [showRunbook, setShowRunbook] = useState(false);

  const active = (events ?? [])
    .filter((e) => e.metricType === 'command_p99' && !e.resolved && !dismissed.has(e.id))
    .sort(compareEvents);

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

  const critical = active.some((e) => e.severity === 'critical');
  const count = countCommands(active);

  return (
    <Alert
      variant={critical ? 'destructive' : 'default'}
      className={critical ? 'border-destructive' : undefined}
    >
      <TrendingUp className="w-4 h-4" />
      <AlertTitle>
        P99 latency regression on {count} {count === 1 ? 'command' : 'commands'}
      </AlertTitle>
      <AlertDescription>
        <ul className="divide-y">
          {active.map((event) => {
            const { data, admin } = splitCommands(event);
            return (
              <li key={event.id} className="flex items-start justify-between gap-2 py-1.5">
                <div className="min-w-0">
                  {(data.length > 0 || admin.length > 0) && (
                    <div className="flex flex-wrap items-center gap-2">
                      {data.length > 0 && (
                        <span className="font-mono font-medium">{data.join(', ')}</span>
                      )}
                      {admin.length > 0 && (
                        <>
                          <span className="font-mono text-muted-foreground">
                            {admin.join(', ')}
                          </span>
                          <Badge variant="outline" className="text-muted-foreground font-normal">
                            monitoring/admin command
                          </Badge>
                        </>
                      )}
                    </div>
                  )}
                  <p
                    className={
                      data.length === 0 && admin.length > 0 ? 'text-muted-foreground' : undefined
                    }
                  >
                    {event.message}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => dismiss(event.id)}
                >
                  Mark resolved
                </Button>
              </li>
            );
          })}
        </ul>
        <Button
          size="sm"
          variant="link"
          className="px-0"
          aria-expanded={showRunbook}
          onClick={() => setShowRunbook((open) => !open)}
        >
          {showRunbook ? 'Hide remediation steps' : 'Show remediation steps'}
        </Button>
        {showRunbook && (
          <ol className="list-decimal pl-4 space-y-1">
            {RUNBOOK.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        )}
      </AlertDescription>
    </Alert>
  );
}
