import { useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';

interface Props {
  /** Human-readable feature name, e.g. "Slow Log". */
  featureName: string;
  /** Underlying command that is blocked, e.g. "SLOWLOG". */
  command: string;
  /** Verbatim error string from the server, e.g. "ERR Command is not available: 'SLOWLOG'". */
  reason?: string;
  /** Unix-ms timestamp when the capability was disabled. */
  disabledAt?: number;
  /** Handler invoked when the user clicks Retry. */
  onRetry?: () => Promise<void> | void;
}

function formatDisabledAt(disabledAt: number | undefined): string | null {
  if (!disabledAt) {
    return null;
  }
  const seconds = Math.max(0, Math.round((Date.now() - disabledAt) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m ago`;
  }
  return `${Math.round(seconds / 3600)}h ago`;
}

/**
 * Non-blocking banner shown at the top of feature pages when the underlying
 * command is unavailable on the connected database (typically because a
 * managed provider — Upstash, ElastiCache Serverless, etc. — restricts it).
 *
 * Pair this with the `useCapabilities()` hook + the
 * `/connections/:id/capabilities/:capability/retry` endpoint to wire the
 * Retry button.
 */
export function CapabilityUnavailableBanner({
  featureName,
  command,
  reason,
  disabledAt,
  onRetry,
}: Props) {
  const [retrying, setRetrying] = useState(false);
  const disabledLabel = formatDisabledAt(disabledAt);

  const handleRetry = async () => {
    if (!onRetry) {
      return;
    }
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div
      role="alert"
      className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
    >
      <AlertTriangle className="size-5 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="flex-1 min-w-0 space-y-1">
        <div className="font-medium">
          {featureName} is unavailable on this connection
        </div>
        <div className="text-muted-foreground">
          The <code className="px-1 py-0.5 bg-background rounded text-xs">{command}</code>{' '}
          command was rejected by the server, so we&apos;ve paused polling it.
          {disabledLabel && (
            <span className="ml-1 text-xs">(disabled {disabledLabel})</span>
          )}
        </div>
        {reason && (
          <div className="font-mono text-xs bg-background/60 rounded px-2 py-1 break-words">
            {reason}
          </div>
        )}
      </div>
      {onRetry && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRetry}
          disabled={retrying}
          className="self-start sm:self-center"
        >
          <RefreshCw className={retrying ? 'animate-spin' : ''} />
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
      )}
    </div>
  );
}
