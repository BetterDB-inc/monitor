import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { monitorApi } from '../../api/monitor';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';

export interface CaptureOnNextContext {
  connectionId: string;
  metricType: string;
  metricLabel: string;
  anomalyType: string;
  source: 'event' | 'group';
}

interface CaptureOnNextModalProps {
  open: boolean;
  context: CaptureOnNextContext | undefined;
  onOpenChange: (open: boolean) => void;
}

export function CaptureOnNextModal({ open, context, onOpenChange }: CaptureOnNextModalProps) {
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [createdId, setCreatedId] = useState<string | undefined>();

  useEffect(() => {
    if (!open) {
      setSubmitting(false);
      setError(undefined);
      setCreatedId(undefined);
    }
  }, [open]);

  async function handleConfirm() {
    if (!context) {
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const trigger = await monitorApi.createTrigger({
        connectionId: context.connectionId,
        metricType: context.metricType,
        anomalyType: context.anomalyType,
      });
      setCreatedId(trigger.id);
      await queryClient.invalidateQueries({
        queryKey: ['monitor', 'triggers', context.connectionId],
      });
    } catch (err) {
      setError((err as Error).message ?? 'Failed to create trigger');
    } finally {
      setSubmitting(false);
    }
  }

  const metricLabel = context?.metricLabel ?? context?.metricType ?? '';
  const anomalyLabel = context?.anomalyType ?? '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Capture on next occurrence</DialogTitle>
          <DialogDescription>
            Schedule a MONITOR capture to start automatically the next time this anomaly
            recurs. Auto-clears after one capture or in 24h.
          </DialogDescription>
        </DialogHeader>

        {context && (
          <div className="space-y-3 py-2 text-sm">
            <p>
              Capture next <span className="font-medium">{anomalyLabel}</span> on{' '}
              <span className="font-medium">{metricLabel}</span>.
            </p>
            <p className="text-xs text-muted-foreground">
              Connection: <span className="font-mono">{context.connectionId}</span>
            </p>
          </div>
        )}

        {createdId && (
          <div className="rounded border border-primary/40 bg-primary/10 p-3 text-xs">
            Trigger created. It will fire on the next matching anomaly within 24 hours.
          </div>
        )}

        {error && (
          <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            {error}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {createdId ? 'Close' : 'Cancel'}
          </Button>
          {!createdId && (
            <Button onClick={handleConfirm} disabled={!context || submitting}>
              {submitting ? 'Creating…' : 'Create trigger'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
