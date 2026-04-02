import { useState, useEffect, useRef } from 'react';
import { fetchApi } from '../../api/client';
import type { MigrationExecutionResult } from '@betterdb/shared';
import { ExecutionLogViewer } from './ExecutionLogViewer';

interface Props {
  executionId: string;
  onStopped: () => void;
}

function formatElapsed(startedAt: number, completedAt?: number): string {
  const end = completedAt ?? Date.now();
  const seconds = Math.floor((end - startedAt) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'running':
      return <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800"><span className="animate-spin h-3 w-3 border-2 border-blue-400 border-t-transparent rounded-full" /> Running</span>;
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

export function ExecutionPanel({ executionId, onStopped }: Props) {
  const [execution, setExecution] = useState<MigrationExecutionResult | null>(null);
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
        setExecution(result);
        if (result.status === 'completed' || result.status === 'failed' || result.status === 'cancelled') {
          onStoppedRef.current();
          return;
        }
      } catch {
        if (stopped) return;
        errorCount++;
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

  if (!execution) {
    return (
      <div className="bg-card border rounded-lg p-6">
        <p className="text-sm text-muted-foreground">Starting migration...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Status bar */}
      <div className="bg-card border rounded-lg p-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <StatusBadge status={execution.status} />
          <span className="px-2 py-0.5 rounded text-xs bg-muted text-muted-foreground">
            {execution.mode === 'command' ? 'Command' : 'RedisShake'}
          </span>
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
        </div>
        {execution.status === 'running' && (
          <button
            onClick={handleStop}
            className="px-3 py-1.5 text-sm border border-destructive/20 text-destructive rounded-md hover:bg-destructive/10"
          >
            Stop Migration
          </button>
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

      {/* Status banners */}
      {execution.status === 'failed' && (
        <div className="bg-destructive/10 border border-destructive/20 text-destructive rounded-lg p-4 text-sm">
          {execution.error ?? 'Migration failed'}
        </div>
      )}
      {execution.status === 'completed' && (
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
      <ExecutionLogViewer logs={execution.logs} />
    </div>
  );
}
