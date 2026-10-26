import { useState } from 'react';
import type { MigrationExecutionResult } from '@betterdb/shared';
import { formatBytes } from '../../lib/utils';

interface Props {
  execution: MigrationExecutionResult;
  onComplete: (force: boolean) => Promise<void>;
}

type Confirming = 'complete' | 'force' | null;

const CONFIRM_TEXT =
  "Before you continue: pause writes on the source. Lag 0 cannot detect writes that are still arriving, so writes made after the cutover are lost. The migration finishes once every shard's lag stays at 0. After it completes, point your application at the target.";

const primaryButton = 'px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed';
const amberButton = 'px-3 py-1.5 text-sm rounded-md bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed';
const outlineButton = 'px-3 py-1.5 text-sm rounded-md border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed';

export function CutoverControls({ execution, onComplete }: Props) {
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (execution.mode !== 'redis_shake_sync' || execution.status !== 'running') {
    return null;
  }

  const timedOut = execution.cutover?.outcome === 'timed_out';
  const lagEntries = execution.replicationLag ?? [];
  const unreported = Math.max(0, (execution.expectedShards ?? 0) - lagEntries.length);
  const ready = execution.syncStage === 'aof_replicating';

  const submit = async (force: boolean) => {
    setSubmitting(true);
    setError(null);
    try {
      await onComplete(force);
      setConfirming(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Cutover request failed');
    } finally {
      setSubmitting(false);
    }
  };

  const open = (next: Confirming) => {
    setError(null);
    setConfirming(next);
  };

  return (
    <div className="space-y-2">
      {confirming === null && (
        <div className="flex flex-wrap items-center gap-2">
          {timedOut ? (
            <>
              <button onClick={() => open('complete')} className={primaryButton}>
                Retry cutover
              </button>
              <button onClick={() => open('force')} className={amberButton}>
                Force cutover
              </button>
            </>
          ) : (
            <button
              onClick={() => open('complete')}
              disabled={!ready}
              title={ready ? undefined : 'Available once the initial sync finishes'}
              className={primaryButton}
            >
              Complete cutover
            </button>
          )}
        </div>
      )}

      {confirming === 'complete' && (
        <div className="space-y-2 max-w-xl">
          <p className="text-sm">{CONFIRM_TEXT}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => submit(false)} disabled={submitting} className={primaryButton}>
              Complete cutover
            </button>
            <button onClick={() => setConfirming(null)} disabled={submitting} className={outlineButton}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirming === 'force' && (
        <div className="space-y-2 max-w-xl">
          <p className="text-sm">Force the cutover now? Writes not yet on the target will be missing:</p>
          {lagEntries.length === 0 && unreported === 0 ? (
            <p className="text-sm">No shard has reported lag yet.</p>
          ) : (
            <ul className="text-sm list-disc pl-5">
              {lagEntries.map((entry) => (
                <li key={entry.shard}>
                  {entry.diff === null
                    ? `${entry.shard}: initial sync`
                    : `${entry.shard}: ${formatBytes(entry.diff)} behind`}
                </li>
              ))}
              {unreported > 0 && <li>{`${unreported} shard(s) with no report`}</li>}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => submit(true)} disabled={submitting} className={amberButton}>
              Force cutover
            </button>
            <button onClick={() => setConfirming(null)} disabled={submitting} className={outlineButton}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
