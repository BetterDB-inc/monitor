import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { InferenceSlaConfig, InferenceSlaEntry } from '@betterdb/shared';
import { Feature } from '@betterdb/shared';
import { settingsApi } from '../../api/settings';
import { useLicense } from '../../hooks/useLicense';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';

interface Props {
  indexName: string;
  trigger: React.ReactNode;
}

const DEFAULT_THRESHOLD_US = 20_000;

export function InferenceSlaConfig({ indexName, trigger }: Props) {
  const { hasFeature, tier } = useLicense();
  const canConfigure = hasFeature(Feature.INFERENCE_SLA);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [thresholdMsInput, setThresholdMsInput] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.getSettings(),
    enabled: open,
  });

  const current: InferenceSlaEntry | undefined =
    settingsQuery.data?.settings.inferenceSlaConfig?.[indexName];

  useEffect(() => {
    if (!open) return;
    const thresholdUs = current?.p99ThresholdUs ?? DEFAULT_THRESHOLD_US;
    setThresholdMsInput((thresholdUs / 1_000).toString());
    setEnabled(current?.enabled ?? true);
    setError(null);
  }, [open, current]);

  const updateMutation = useMutation({
    mutationFn: async (update: InferenceSlaConfig) => settingsApi.updateSettings({
      inferenceSlaConfig: update,
    }),
    onSuccess: (response) => {
      queryClient.setQueryData(['settings'], response);
      setOpen(false);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save'),
  });

  const handleSave = () => {
    const thresholdMs = Number(thresholdMsInput);
    if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
      setError('Threshold must be a positive number of milliseconds.');
      return;
    }
    const existing = settingsQuery.data?.settings.inferenceSlaConfig ?? {};
    updateMutation.mutate({
      ...existing,
      [indexName]: { p99ThresholdUs: Math.round(thresholdMs * 1_000), enabled },
    });
  };

  const handleRemove = () => {
    const existing = settingsQuery.data?.settings.inferenceSlaConfig ?? {};
    const { [indexName]: _dropped, ...rest } = existing;
    void _dropped;
    updateMutation.mutate(rest);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Inference SLA — {indexName}</DialogTitle>
          <DialogDescription>
            Configure the per-index p99 latency budget for {indexName}. Breaches fire an
            <code className="mx-1 px-1 py-0.5 bg-muted rounded text-xs">
              inference.sla.breach
            </code>
            webhook (debounced 10 minutes per index).
          </DialogDescription>
        </DialogHeader>

        {!canConfigure ? (
          <Alert>
            <AlertTitle>
              Pro feature <Badge variant="secondary" className="ml-2">{tier}</Badge>
            </AlertTitle>
            <AlertDescription>
              Per-index SLAs, breach webhooks, and the historical trend require a Pro license.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">p99 threshold (ms)</label>
              <Input
                type="number"
                min="0"
                step="0.1"
                value={thresholdMsInput}
                onChange={(e) => setThresholdMsInput(e.target.value)}
                disabled={updateMutation.isPending}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                disabled={updateMutation.isPending}
              />
              Enabled
            </label>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          {canConfigure && current && (
            <Button
              type="button"
              variant="ghost"
              onClick={handleRemove}
              disabled={updateMutation.isPending}
            >
              Remove SLA
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={updateMutation.isPending}
          >
            Cancel
          </Button>
          {canConfigure && (
            <Button type="button" onClick={handleSave} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
