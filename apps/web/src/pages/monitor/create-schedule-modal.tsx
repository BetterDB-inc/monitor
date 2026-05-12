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
import { Input } from '../../components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';

interface CreateScheduleModalProps {
  open: boolean;
  connectionId: string;
  onOpenChange: (open: boolean) => void;
}

type IntervalUnit = 'seconds' | 'minutes' | 'hours';

const UNIT_TO_SECONDS: Record<IntervalUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
};

export function CreateScheduleModal({
  open,
  connectionId,
  onOpenChange,
}: CreateScheduleModalProps) {
  const queryClient = useQueryClient();
  const [advanced, setAdvanced] = useState(false);
  const [intervalAmount, setIntervalAmount] = useState('5');
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>('minutes');
  const [cronExpression, setCronExpression] = useState('');
  const [durationSeconds, setDurationSeconds] = useState('5');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [createdId, setCreatedId] = useState<string | undefined>();

  useEffect(() => {
    if (!open) {
      setAdvanced(false);
      setIntervalAmount('5');
      setIntervalUnit('minutes');
      setCronExpression('');
      setDurationSeconds('5');
      setSubmitting(false);
      setError(undefined);
      setCreatedId(undefined);
    }
  }, [open]);

  async function handleSubmit() {
    setError(undefined);
    const durationMs = Math.round(Number(durationSeconds) * 1000);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      setError('Duration must be a positive number of seconds');
      return;
    }

    let payload: Parameters<typeof monitorApi.createSchedule>[0];
    if (advanced) {
      const expression = cronExpression.trim();
      if (!expression) {
        setError('Cron expression is required');
        return;
      }
      payload = { connectionId, cronExpression: expression, durationMs };
    } else {
      const amount = Number(intervalAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        setError('Interval must be a positive number');
        return;
      }
      const intervalSeconds = Math.round(amount * UNIT_TO_SECONDS[intervalUnit]);
      payload = { connectionId, intervalSeconds, durationMs };
    }

    setSubmitting(true);
    try {
      const schedule = await monitorApi.createSchedule(payload);
      setCreatedId(schedule.id);
      await queryClient.invalidateQueries({
        queryKey: ['monitor', 'schedules', connectionId],
      });
    } catch (err) {
      setError((err as Error).message ?? 'Failed to create schedule');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New scheduled capture</DialogTitle>
          <DialogDescription>
            Run a MONITOR capture on a fixed cadence. Duration counts the per-fire capture
            window — independent of the cadence.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 text-sm">
          {!advanced && (
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase text-muted-foreground">
                Run every
              </label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  className="w-24"
                  value={intervalAmount}
                  onChange={(e) => setIntervalAmount(e.target.value)}
                  disabled={submitting || createdId !== undefined}
                />
                <Select
                  value={intervalUnit}
                  onValueChange={(v) => setIntervalUnit(v as IntervalUnit)}
                  disabled={submitting || createdId !== undefined}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="seconds">seconds</SelectItem>
                    <SelectItem value="minutes">minutes</SelectItem>
                    <SelectItem value="hours">hours</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">
                Minimum 10 seconds between fires.
              </p>
            </div>
          )}

          {advanced && (
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase text-muted-foreground">
                Cron expression
              </label>
              <Input
                placeholder="*/5 * * * *"
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                disabled={submitting || createdId !== undefined}
              />
              <p className="text-xs text-muted-foreground">
                Standard 5- or 6-field cron. Validated server-side.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-xs font-medium uppercase text-muted-foreground">
              Capture duration (seconds)
            </label>
            <Input
              type="number"
              min={1}
              value={durationSeconds}
              onChange={(e) => setDurationSeconds(e.target.value)}
              disabled={submitting || createdId !== undefined}
            />
          </div>

          <button
            type="button"
            className="text-xs text-primary underline"
            onClick={() => setAdvanced((v) => !v)}
            disabled={submitting || createdId !== undefined}
          >
            {advanced ? 'Use simple interval' : 'Advanced (cron expression)'}
          </button>
        </div>

        {createdId && (
          <div className="rounded border border-primary/40 bg-primary/10 p-3 text-xs">
            Schedule created. It will start firing on the next interval.
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
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Creating…' : 'Create schedule'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
