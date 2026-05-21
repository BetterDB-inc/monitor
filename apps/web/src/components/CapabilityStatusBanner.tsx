import { useState } from 'react';
import { AlertTriangle, XCircle, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';

interface Props {
  featureName: string;
  command: string;
  /** Verbatim server error to surface in the error banner. */
  reason: string;
  /** Called on retry. Should re-probe the capability and resolve when done. */
  onRetry?: () => Promise<void> | void;
}

/**
 * Stacked warn + error banners shown above page content when a capability is
 * unavailable. The retry button sits at top-right of the block. While a retry
 * is in flight, the error banner is replaced with a "Force-retrying X…"
 * message so the operator gets immediate feedback that the click landed.
 *
 * On successful retry the caller's effect (capability state changes to
 * available) will unmount this component; on failure the new reason is
 * delivered through props (`reason` updates) and the banner stays.
 */
export function CapabilityStatusBanner({ featureName, command, reason, onRetry }: Props) {
  const [retrying, setRetrying] = useState(false);

  const handleRetry = async () => {
    if (!onRetry) {
      return;
    }
    setRetrying(true);
    try {
      // Brief delay so the "Force-retrying…" state is actually perceptible
      // before the (typically <100 ms) probe round-trip resolves it.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="space-y-2">
      <div
        role="alert"
        className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-amber-900 dark:text-amber-100">
            {featureName} unavailable
          </div>
          <div className="mt-0.5 text-xs text-amber-900/80 dark:text-amber-100/80">
            The <code className="rounded bg-amber-500/10 px-1 py-0.5">{command}</code> command
            is not available for this database instance. This can happen with managed services
            (e.g. AWS ElastiCache Serverless, Upstash) that restrict certain commands.
          </div>
        </div>
      </div>
      <div
        role="alert"
        className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3"
      >
        <XCircle className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
        <div className="flex-1 min-w-0 break-words font-mono text-xs text-red-900 dark:text-red-100">
          {retrying ? `Force-retrying ${command}…` : reason}
        </div>
      </div>
      {onRetry && (
        <div className="flex justify-start">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRetry}
            disabled={retrying}
          >
            <RefreshCw className={retrying ? 'animate-spin' : ''} />
            {retrying ? 'Retrying…' : 'Retry now'}
          </Button>
        </div>
      )}
    </div>
  );
}
