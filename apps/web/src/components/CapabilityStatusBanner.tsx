import { useState } from 'react';
import { AlertTriangle, XCircle, RefreshCw, HelpCircle } from 'lucide-react';
import { Button } from './ui/button';
import type { CapabilityRetryVerdict } from '../types/metrics';

const PERCEPTIBLE_RETRY_DELAY_MS = 3000;

interface Props {
  featureName: string;
  command: string;
  reason: string;
  /**
   * Called on retry. Returns the probe verdict so the banner can render an
   * `'unknown'` (transient) outcome in an amber tone instead of red.
   * Optional — without it the Retry button is hidden.
   */
  onRetry?: () => Promise<CapabilityRetryVerdict | undefined> | CapabilityRetryVerdict | void;
}

export function CapabilityStatusBanner({ featureName, command, reason, onRetry }: Props) {
  const [retrying, setRetrying] = useState(false);
  const [lastVerdict, setLastVerdict] = useState<CapabilityRetryVerdict | null>(null);

  const handleRetry = async () => {
    if (!onRetry) {
      return;
    }
    setRetrying(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, PERCEPTIBLE_RETRY_DELAY_MS));
      const verdict = await onRetry();
      setLastVerdict(verdict ?? null);
    } finally {
      setRetrying(false);
    }
  };

  const lastWasTransient = lastVerdict?.available === 'unknown';
  // The verdict's reason (transient error) is fresher than the prop-level
  // disabled-because reason when the last retry was inconclusive.
  const displayedReason = lastWasTransient && lastVerdict?.reason ? lastVerdict.reason : reason;

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
      {retrying ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-900 dark:text-amber-100"
        >
          <RefreshCw className="mt-0.5 size-4 shrink-0 animate-spin text-amber-600 dark:text-amber-400" />
          <div className="min-w-0">Force-retrying {command}…</div>
        </div>
      ) : lastWasTransient ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3"
        >
          <HelpCircle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="flex-1 min-w-0 space-y-1 text-amber-900 dark:text-amber-100">
            <div className="text-xs font-medium">
              Couldn&apos;t verify — transient error. Try again.
            </div>
            <div className="break-words font-mono text-xs text-amber-900/80 dark:text-amber-100/80">
              {displayedReason}
            </div>
          </div>
        </div>
      ) : (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3"
        >
          <XCircle className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
          <div className="flex-1 min-w-0 break-words font-mono text-xs text-red-900 dark:text-red-100">
            {displayedReason}
          </div>
        </div>
      )}
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
