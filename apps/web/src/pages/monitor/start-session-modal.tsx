import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { monitorApi, PreflightResult, StoredCaptureSession } from '../../api/monitor';
import { PreflightPanel } from './preflight-panel';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const DEFAULT_DURATION_SECONDS = 30;

interface Props {
  connectionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (session: StoredCaptureSession) => void;
}

type Unit = 's' | 'm';

export function StartSessionModal({ connectionId, open, onOpenChange, onStarted }: Props) {
  const [duration, setDuration] = useState<number>(DEFAULT_DURATION_SECONDS);
  const [unit, setUnit] = useState<Unit>('s');
  const [requestedBy, setRequestedBy] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);

  const durationMs = duration * (unit === 'm' ? 60_000 : 1000);
  const exceedsWarn = durationMs > FIVE_MINUTES_MS;

  // Drop the confirmation panel when the duration falls back below the warn threshold.
  useEffect(() => {
    if (!exceedsWarn && confirming) setConfirming(false);
  }, [exceedsWarn, confirming]);

  // Reset all form + transient state on close so reopening always shows fresh defaults.
  useEffect(() => {
    if (!open) {
      setDuration(DEFAULT_DURATION_SECONDS);
      setUnit('s');
      setRequestedBy('');
      setPreflight(null);
      setPreflightError(null);
      setConfirming(false);
      setError(null);
    }
  }, [open]);

  // Refresh pre-flight whenever the modal opens or duration changes (debounced via effect deps).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreflightLoading(true);
    setPreflightError(null);
    monitorApi
      .preflight(connectionId, durationMs)
      .then((result) => {
        if (!cancelled) setPreflight(result);
      })
      .catch((err: Error) => {
        if (!cancelled) setPreflightError(err.message);
      })
      .finally(() => {
        if (!cancelled) setPreflightLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, connectionId, durationMs]);

  const handleSubmit = async () => {
    if (exceedsWarn && !confirming) {
      setConfirming(true);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const session = await monitorApi.startSession({
        connectionId,
        durationMs,
        requestedBy: requestedBy.trim() || undefined,
      });
      onStarted(session);
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
      setConfirming(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Start MONITOR capture session</DialogTitle>
          <DialogDescription>
            Captures every command processed by the selected instance for the chosen duration.
            Server-side caps still apply; review the pre-flight report below.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2 flex items-end gap-2">
              <div className="flex-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="duration">
                  Duration
                </label>
                <Input
                  id="duration"
                  type="number"
                  min={1}
                  value={duration}
                  onChange={(e) => setDuration(Math.max(1, Number(e.target.value) || 1))}
                />
              </div>
              <select
                aria-label="Duration unit"
                value={unit}
                onChange={(e) => setUnit(e.target.value as Unit)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="s">seconds</option>
                <option value="m">minutes</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground" htmlFor="requestedBy">
                Requested by (optional)
              </label>
              <Input
                id="requestedBy"
                value={requestedBy}
                onChange={(e) => setRequestedBy(e.target.value)}
                placeholder="your-handle"
              />
            </div>
          </div>

          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Pre-flight
            </div>
            {preflightLoading && !preflight && (
              <p className="text-sm text-muted-foreground">Running pre-flight…</p>
            )}
            {preflightError && (
              <p className="text-sm text-destructive">Pre-flight failed: {preflightError}</p>
            )}
            {preflight && <PreflightPanel preflight={preflight} />}
          </div>

          {confirming && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
              <p className="font-medium text-amber-800 dark:text-amber-200">
                Sessions over 5 minutes can produce significant load. Confirm to proceed.
              </p>
              <p className="mt-1 text-xs text-amber-700/90 dark:text-amber-200/80">
                Duration: {duration}{unit === 'm' ? ' min' : ' s'} ({durationMs.toLocaleString()} ms)
              </p>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || preflightLoading}>
            {submitting
              ? 'Starting…'
              : confirming
                ? 'Yes, start session'
                : 'Start session'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
