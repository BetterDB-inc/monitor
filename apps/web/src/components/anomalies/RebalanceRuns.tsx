import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { metricsApi } from '../../api/metrics';
import { useCanMutate } from '../../hooks/useCanMutate';
import { usePolling } from '../../hooks/usePolling';
import type {
  RebalanceExecutionBlocker,
  RebalanceJobState,
  RebalanceRun,
  RebalanceRunJob,
  RebalanceRunState,
} from '../../types/anomaly';
import { REBALANCE_BLOCKED, formatRatio, formatSlotRanges, shortShardId } from './anomaly-display';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

const RUNNING_POLL_MS = 5000;
const IDLE_POLL_MS = 30000;

const RUN_STATE: Record<RebalanceRunState, string> = {
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  unknown: 'Unknown',
};

const JOB_STATE: Record<RebalanceJobState, string> = {
  starting: 'starting',
  running: 'running',
  succeeded: 'moved',
  failed: 'failed',
  cancelled: 'cancelled',
  unknown: 'no longer listed; the outcome is not known',
};

function describeJob(job: RebalanceRunJob): string {
  const ranges = formatSlotRanges(job.ranges).join(', ');
  const phase = job.state === 'running' && job.phase ? ` (${job.phase})` : '';
  const message = job.message ? `: ${job.message}` : '';
  return `Slots ${ranges} to ${job.targetAddr}: ${JOB_STATE[job.state]}${phase}${message}.`;
}

function describeOutcome(run: RebalanceRun): string | null {
  if (run.state !== 'succeeded') return null;
  if (!run.outcome) return 'Measuring the load now that the slots have moved.';
  return (
    `Projected ${formatRatio(run.outcome.projectedRatio)} the median for the hot shard; ` +
    `measured ${formatRatio(run.outcome.actualRatio)}.`
  );
}

function cancelRefusal(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) return 'The migration is no longer running.';
  if (err instanceof ApiError) {
    const payload = (err.payload ?? {}) as {
      message?: string;
      blockedBy?: RebalanceExecutionBlocker;
    };
    return (
      (payload.blockedBy && REBALANCE_BLOCKED[payload.blockedBy]) || payload.message || err.message
    );
  }
  return err instanceof Error ? err.message : String(err);
}

function CancelRun({ run, connectionId }: { run: RebalanceRun; connectionId: string | undefined }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = async () => {
    setSending(true);
    setError(null);
    try {
      await metricsApi.cancelRebalance(run.sourceShardId);
      setOpen(false);
    } catch (err) {
      setError(cancelRefusal(err));
    } finally {
      setSending(false);
      await queryClient.invalidateQueries({ queryKey: ['slot-rebalance-runs', connectionId] });
    }
  };
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Cancel
      </Button>
      <Dialog open={open} onOpenChange={(next) => !sending && setOpen(next)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel the migration?</DialogTitle>
            <DialogDescription>
              BetterDB sends CLUSTER CANCELSLOTMIGRATIONS to {run.sourceAddr}. It stops every slot
              migration on that shard, not only this one.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={sending} onClick={() => setOpen(false)}>
              Keep it running
            </Button>
            <Button variant="destructive" disabled={sending} onClick={cancel}>
              {sending ? 'Cancelling…' : 'Cancel the migration'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface Props {
  connectionId: string | undefined;
}

export function RebalanceRuns({ connectionId }: Props) {
  const canMutate = useCanMutate();
  const { data: runs, error } = usePolling<RebalanceRun[]>({
    fetcher: () => metricsApi.getRebalanceRuns(),
    interval: (data) =>
      data?.some((run) => run.state === 'running' || (run.state === 'succeeded' && !run.outcome))
        ? RUNNING_POLL_MS
        : IDLE_POLL_MS,
    enabled: !!connectionId,
    queryKey: ['slot-rebalance-runs', connectionId],
  });
  if (!connectionId || !runs) return null;
  return (
    <>
      {error && runs.length > 0 && (
        <p role="alert" className="text-sm text-destructive">
          Could not refresh the slot rebalance runs. The last state read is shown.
        </p>
      )}
      {runs.map((run) => {
        const title = `Slot rebalance from shard ${shortShardId(run.sourceShardId)} at ${run.sourceAddr}`;
        const outcome = describeOutcome(run);
        return (
          <Card key={`${run.sourceShardId} ${run.startedAt}`} role="region" aria-label={title}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                {title}
                <Badge variant={run.state === 'running' ? 'default' : 'secondary'}>
                  {RUN_STATE[run.state]}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                Started from BetterDB by {run.startedBy.email ?? 'an admin'} at{' '}
                {new Date(run.startedAt).toLocaleTimeString()}.
              </p>
              <ul className="list-disc pl-5">
                {run.jobs.map((job) => (
                  <li key={job.targetShardId}>{describeJob(job)}</li>
                ))}
              </ul>
              {outcome && <p>{outcome}</p>}
              {run.state === 'running' && canMutate && (
                <CancelRun run={run} connectionId={connectionId} />
              )}
            </CardContent>
          </Card>
        );
      })}
    </>
  );
}
