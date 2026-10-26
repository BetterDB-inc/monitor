import { useState, useEffect, useRef } from 'react';
import { fetchApi } from '../../api/client';
import type { CompleteExecutionResponse, MigrationExecutionResult, SyncStage } from '@betterdb/shared';
import { ExecutionLogViewer } from './ExecutionLogViewer';
import { ReplicationLag } from './ReplicationLag';
import { CutoverControls } from './CutoverControls';

interface Props {
  executionId: string;
  onStopped: () => void;
  /**
   * Re-run this migration with the target flushed first. Provided by the page (which
   * holds the source/target/mode). When set, a BUSYKEY failure offers a one-click
   * "Flush target & retry" — the remediation the error text describes.
   */
  onRetryFlush?: () => void;
  /**
   * True while a start/retry request is in flight (the page's `migrationStarting`).
   * The retry control disables and shows in-flight state so a second click can't
   * fire another flush+job that races the first on the same target.
   */
  retryPending?: boolean;
}

function formatElapsed(startedAt: number, completedAt?: number): string {
  const end = completedAt ?? Date.now();
  const seconds = Math.floor((end - startedAt) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatRemaining(deadlineAt: number): string {
  const seconds = Math.max(0, Math.floor((deadlineAt - Date.now()) / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function latestNotice(notices: string[] | undefined, prefix: string): string | undefined {
  return [...(notices ?? [])].reverse().find((notice) => notice.startsWith(prefix));
}

function syncStageLabel(
  stage: SyncStage,
  fullySynced: boolean,
  completing: boolean,
): { label: string; className: string } | null {
  if (completing) {
    return { label: 'Completing cutover', className: 'bg-amber-50 text-amber-800 border border-amber-200' };
  }
  switch (stage) {
    case 'connecting':
      return { label: 'Connecting', className: 'bg-muted text-muted-foreground' };
    case 'rdb_syncing':
      return { label: 'Initial sync (RDB)', className: 'bg-blue-50 text-blue-700 border border-blue-200' };
    case 'aof_replicating':
      return fullySynced
        ? { label: 'Fully synced', className: 'bg-green-50 text-green-700 border border-green-200' }
        : { label: 'Replicating', className: 'bg-blue-50 text-blue-700 border border-blue-200' };
    default:
      return null;
  }
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'running':
      return <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800"><span className="animate-spin h-3 w-3 border-2 border-blue-400 border-t-transparent rounded-full" /> Running</span>;
    case 'completing':
      return <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800"><span className="animate-spin h-3 w-3 border-2 border-amber-400 border-t-transparent rounded-full" /> Completing</span>;
    case 'completed':
      return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">Completed</span>;
    case 'failed':
      return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-destructive/10 text-destructive">Failed</span>;
    case 'cancelled':
      return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">Cancelled</span>;
    default:
      return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-muted text-foreground">{status}</span>;
  }
}

export function ExecutionPanel({ executionId, onStopped, onRetryFlush, retryPending }: Props) {
  const [execution, setExecution] = useState<MigrationExecutionResult | null>(null);
  const [confirmingFlush, setConfirmingFlush] = useState(false);
  const [pollFailed, setPollFailed] = useState(false);
  const onStoppedRef = useRef(onStopped);
  onStoppedRef.current = onStopped;

  useEffect(() => {
    let stopped = false;
    let errorCount = 0;
    const poll = async () => {
      try {
        const result = await fetchApi<MigrationExecutionResult>(`/migration/execution/${executionId}`);
        if (stopped) return;
        errorCount = 0;
        setPollFailed(false);
        setExecution(result);
        if (result.status === 'completed' || result.status === 'failed' || result.status === 'cancelled') {
          onStoppedRef.current();
          return;
        }
      } catch {
        if (stopped) return;
        errorCount++;
        setPollFailed(true);
      }
      if (!stopped) {
        const delay = errorCount > 0 ? Math.min(2000 * 2 ** errorCount, 30000) : 2000;
        timer = setTimeout(poll, delay);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [executionId]);

  const handleStop = async () => {
    try {
      await fetchApi(`/migration/execution/${executionId}`, { method: 'DELETE' });
    } catch {
      /* ignore */
    }
    // Optimistic transition
    onStoppedRef.current();
  };

  const handleComplete = async (force: boolean) => {
    const result = await fetchApi<CompleteExecutionResponse>(`/migration/execution/${executionId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    });
    setExecution((current) =>
      current ? { ...current, status: result.status, cutover: result.cutover ?? current.cutover } : current,
    );
  };

  if (!execution) {
    return (
      <div className="bg-card border rounded-lg p-6">
        <p className="text-sm text-muted-foreground">Starting migration...</p>
      </div>
    );
  }

  const timedOut = execution.status === 'running' && execution.cutover?.outcome === 'timed_out';

  return (
    <div className="space-y-4">
      {/* Status bar */}
      <div className="bg-card border rounded-lg p-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <StatusBadge status={execution.status} />
          <span className="px-2 py-0.5 rounded text-xs bg-muted text-muted-foreground">
            {execution.mode === 'command'
              ? 'Command'
              : execution.mode === 'redis_shake_sync'
                ? 'RedisShake (Sync)'
                : 'RedisShake'}
          </span>
          {execution.mode === 'redis_shake_sync' && (() => {
            const stage = syncStageLabel(
              execution.syncStage,
              execution.fullySynced && !pollFailed,
              execution.status === 'completing',
            );
            if (!stage) return null;
            return (
              <span className={`px-2 py-0.5 rounded text-xs ${stage.className}`}>
                {stage.label}
              </span>
            );
          })()}
          {execution.replicationLag && (
            <ReplicationLag
              entries={execution.replicationLag}
              expectedShards={execution.expectedShards}
              now={Date.now()}
            />
          )}
          <span className="text-sm text-muted-foreground">
            {(execution.keysTransferred ?? 0).toLocaleString()}
            {execution.totalKeys ? ` / ${execution.totalKeys.toLocaleString()}` : ''} keys transferred
          </span>
          {(execution.keysSkipped ?? 0) > 0 && (
            <span className="text-sm text-amber-600">
              {execution.keysSkipped!.toLocaleString()} skipped
            </span>
          )}
          <span className="text-sm text-muted-foreground">
            {formatElapsed(execution.startedAt, execution.completedAt)}
          </span>
          {execution.status === 'completing' && execution.cutover && (
            <span className="text-sm text-amber-700">
              Waiting for zero lag · {formatRemaining(execution.cutover.deadlineAt)} left
            </span>
          )}
        </div>
        {(execution.status === 'running' || execution.status === 'completing') && (
          <div className="flex items-start gap-2">
            {!timedOut && <CutoverControls execution={execution} onComplete={handleComplete} />}
            <button
              onClick={handleStop}
              className="px-3 py-1.5 text-sm border border-destructive/20 text-destructive rounded-md hover:bg-destructive/10"
            >
              Stop Migration
            </button>
          </div>
        )}
      </div>

      {/* Progress bar — shown while running */}
      {execution.status === 'running' && execution.progress != null && (
        <div className="bg-card border rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Migration progress</span>
            <span className="text-sm text-muted-foreground">{Math.min(100, execution.progress)}%</span>
          </div>
          <div className="w-full bg-muted rounded-full h-2">
            <div
              className="bg-primary h-2 rounded-full transition-all duration-500"
              style={{ width: `${Math.min(100, execution.progress)}%` }}
            />
          </div>
        </div>
      )}

      {execution.status === 'running' &&
       execution.mode === 'redis_shake_sync' &&
       execution.syncStage === 'aof_replicating' &&
       !timedOut && (
        <div className="bg-green-50 border border-green-200 text-green-800 rounded-lg p-4 text-sm space-y-2">
          <p className="font-medium">Initial sync complete. Replicating new writes.</p>
          <p>
            The migration will keep replicating from source to target until you stop it.
            When you're ready to cut over: pause writes on the source, then click Complete cutover.
            Stop Migration cancels without a cutover.
          </p>
        </div>
      )}

      {timedOut && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-4 text-sm space-y-3">
          <p>
            {latestNotice(execution.notices, 'Cutover timed out') ??
              'Cutover timed out: writes on the source are keeping the target behind. Pause writes and retry, or force the cutover.'}
          </p>
          <CutoverControls execution={execution} onComplete={handleComplete} />
        </div>
      )}

      {/* Status banners */}
      {execution.status === 'failed' && (
        <div className="bg-destructive/10 border border-destructive/20 text-destructive rounded-lg p-4 text-sm space-y-3">
          <p>{execution.error ?? 'Migration failed'}</p>
          {execution.failureCode === 'BUSYKEY' && onRetryFlush && (
            retryPending ? (
              <button
                disabled
                className="px-3 py-1.5 text-sm rounded-md border border-destructive/30 inline-flex items-center gap-2 opacity-70 cursor-not-allowed"
              >
                <span className="h-3 w-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                Flushing target &amp; retrying…
              </button>
            ) : confirmingFlush ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs">
                  This <strong>flushes all keys on the target</strong> before retrying and cannot be undone.
                </span>
                <button
                  onClick={() => { setConfirmingFlush(false); onRetryFlush(); }}
                  className="px-3 py-1.5 text-sm rounded-md bg-destructive text-white hover:bg-destructive/90"
                >
                  Flush &amp; retry
                </button>
                <button
                  onClick={() => setConfirmingFlush(false)}
                  className="px-3 py-1.5 text-sm rounded-md border border-destructive/30 hover:bg-destructive/10"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmingFlush(true)}
                className="px-3 py-1.5 text-sm rounded-md border border-destructive/30 hover:bg-destructive/10"
              >
                Flush target &amp; retry
              </button>
            )
          )}
        </div>
      )}
      {execution.status === 'completed' && execution.cutoverAt !== undefined && (
        <div
          className={
            execution.cutover?.outcome === 'forced'
              ? 'bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-4 text-sm'
              : 'bg-green-50 border border-green-200 text-green-700 rounded-lg p-4 text-sm'
          }
        >
          <p>
            {[
              `Cutover complete at ${new Date(execution.cutoverAt).toLocaleTimeString()}. Point your application at the target.`,
              execution.cutover?.outcome === 'forced' ? latestNotice(execution.notices, 'Forced cutover') : undefined,
            ]
              .filter(Boolean)
              .join(' ')}
          </p>
        </div>
      )}
      {execution.status === 'completed' && execution.cutoverAt === undefined && (
        <div className="bg-green-50 border border-green-200 text-green-700 rounded-lg p-4 text-sm">
          Migration complete — {(execution.keysTransferred ?? 0).toLocaleString()} keys transferred
          {(execution.keysSkipped ?? 0) > 0 && `, ${execution.keysSkipped!.toLocaleString()} skipped`}.
        </div>
      )}
      {execution.status === 'cancelled' && (
        <div className="bg-amber-50 border border-amber-200 text-amber-700 rounded-lg p-4 text-sm">
          Migration stopped by user.
        </div>
      )}

      {/* Log viewer */}
      <ExecutionLogViewer logs={execution.logs} notices={execution.notices} />
    </div>
  );
}
