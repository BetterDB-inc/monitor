import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { KvCacheSettingsUpdate } from '@betterdb/shared';
import { kvCacheApi, kvCacheKeys } from '../../../api/kv-cache';
import { useConnection } from '../../../hooks/useConnection';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '../../ui/sheet';
import { Switch } from '../../ui/switch';

const toPercent = (ratio: number) => String(Math.round(ratio * 100));
const isValidPercent = (value: number) => Number.isInteger(value) && value >= 1 && value <= 90;

export function KvCacheSettingsSheet() {
  const queryClient = useQueryClient();
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id ?? null;
  const [open, setOpen] = useState(false);
  const [threshold, setThreshold] = useState('');

  const settings = useQuery({
    queryKey: kvCacheKeys.settings(connectionId),
    queryFn: ({ signal }) => kvCacheApi.getSettings(signal),
    enabled: open && connectionId !== null,
  });

  const save = useMutation({
    mutationFn: (update: KvCacheSettingsUpdate) => kvCacheApi.updateSettings(update),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: kvCacheKeys.settings(connectionId) }),
  });

  const saved = settings.data;

  useEffect(() => {
    if (saved) setThreshold(toPercent(saved.hitRateThreshold));
  }, [saved?.hitRateThreshold]);

  const commitThreshold = () => {
    if (!saved) return;
    const value = Number(threshold);
    if (threshold === '' || !isValidPercent(value)) {
      setThreshold(toPercent(saved.hitRateThreshold));
      return;
    }
    if (value / 100 !== saved.hitRateThreshold) {
      save.mutate({ hitRateThreshold: value / 100 });
    }
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline">Alert settings</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>KV cache alerts</SheetTitle>
          <SheetDescription>
            Webhook events fired for this connection's LMCache footprint and hit rate.
          </SheetDescription>
        </SheetHeader>
        {saved ? (
          <div className="space-y-4 px-4">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                aria-label="Alert on low hit rate"
                checked={saved.hitRateAlertEnabled}
                onCheckedChange={(checked: boolean) =>
                  save.mutate({ hitRateAlertEnabled: checked })
                }
              />
              Alert on low hit rate
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span>Hit rate threshold (%)</span>
              <Input
                aria-label="Hit rate threshold"
                type="number"
                min={1}
                max={90}
                className="w-20"
                value={threshold}
                disabled={!saved.hitRateAlertEnabled}
                onChange={(e) => setThreshold(e.target.value)}
                onBlur={commitThreshold}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                aria-label="Alert on eviction risk"
                checked={saved.evictionAlertEnabled}
                onCheckedChange={(checked: boolean) =>
                  save.mutate({ evictionAlertEnabled: checked })
                }
              />
              Alert on eviction risk
            </label>
            {save.isError ? <p className="text-xs text-destructive">Save failed</p> : null}
          </div>
        ) : (
          <p className="px-4 text-sm text-muted-foreground">
            {settings.isError ? 'Could not load settings' : 'Loading...'}
          </p>
        )}
      </SheetContent>
    </Sheet>
  );
}
