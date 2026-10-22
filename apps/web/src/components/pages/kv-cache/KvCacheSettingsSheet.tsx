import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { KvCacheSettings, KvCacheSettingsUpdate } from '@betterdb/shared';
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

const SAVE_KEY = ['kv-cache', 'settings', 'save'];
const toPercent = (ratio: number) => String(Math.round(ratio * 100));
const isValidPercent = (value: number) => Number.isInteger(value) && value >= 1 && value <= 90;

export function KvCacheSettingsSheet() {
  const queryClient = useQueryClient();
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id ?? null;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ key: string; value: string } | null>(null);
  const submittedThreshold = useRef<number | null>(null);

  const settings = useQuery({
    queryKey: kvCacheKeys.settings(connectionId),
    queryFn: ({ signal }) => kvCacheApi.getSettings(signal),
    enabled: open && connectionId !== null,
  });

  const save = useMutation({
    mutationKey: SAVE_KEY,
    mutationFn: ({ update, target }: { update: KvCacheSettingsUpdate; target: string }) =>
      kvCacheApi.updateSettings(update, target),
    scope: { id: `kv-cache-settings:${connectionId}` },
    onSuccess: (_data, { target }) => {
      const queued = queryClient.isMutating({
        mutationKey: SAVE_KEY,
        predicate: (mutation) =>
          (mutation.state.variables as { target?: string } | undefined)?.target === target,
      });
      if (queued > 1) return;
      return queryClient.invalidateQueries({ queryKey: kvCacheKeys.settings(target) });
    },
    onError: (_error, { update, target }) => {
      if (submittedThreshold.current === update.hitRateThreshold) submittedThreshold.current = null;
      return queryClient.invalidateQueries({ queryKey: kvCacheKeys.settings(target) });
    },
  });

  const saveUpdate = (update: KvCacheSettingsUpdate) => {
    if (connectionId === null) return;
    save.mutate({ update, target: connectionId });
  };

  const toggle = (update: KvCacheSettingsUpdate) => {
    if (connectionId === null) return;
    const key = kvCacheKeys.settings(connectionId);
    void queryClient.cancelQueries({ queryKey: key });
    queryClient.setQueryData<KvCacheSettings>(key, (current) =>
      current ? { ...current, ...update } : current,
    );
    saveUpdate(update);
  };

  const saved = settings.data;

  const draftKey = `${connectionId}|${open}|${saved?.hitRateThreshold}`;
  const threshold =
    draft?.key === draftKey ? draft.value : saved ? toPercent(saved.hitRateThreshold) : '';
  const setThreshold = (value: string) => setDraft({ key: draftKey, value });

  useEffect(() => {
    submittedThreshold.current = null;
  }, [draftKey]);

  const commitThreshold = () => {
    if (!saved) return;
    const value = Number(threshold);
    if (threshold === '' || !isValidPercent(value)) {
      setDraft(null);
      return;
    }
    if (String(value) === toPercent(submittedThreshold.current ?? saved.hitRateThreshold)) return;
    const ratio = value / 100;
    submittedThreshold.current = ratio;
    saveUpdate({ hitRateThreshold: ratio });
  };

  const changeOpen = (next: boolean) => {
    if (!next) commitThreshold();
    setOpen(next);
  };

  const saveFailed = save.isError && save.variables?.target === connectionId;
  const saveError = saveFailed && save.error instanceof Error ? save.error.message : null;

  return (
    <>
      {!open && saveFailed && (
        <span className="text-xs text-destructive">
          Alert settings not saved{saveError ? `: ${saveError}` : ''}
        </span>
      )}
      <Sheet open={open} onOpenChange={changeOpen}>
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
                  onCheckedChange={(checked: boolean) => toggle({ hitRateAlertEnabled: checked })}
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
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitThreshold();
                  }}
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  aria-label="Alert on eviction risk"
                  checked={saved.evictionAlertEnabled}
                  onCheckedChange={(checked: boolean) => toggle({ evictionAlertEnabled: checked })}
                />
                Alert on eviction risk
              </label>
              {saveFailed ? <p className="text-xs text-destructive">Save failed</p> : null}
            </div>
          ) : (
            <p className="px-4 text-sm text-muted-foreground">
              {settings.isError ? 'Could not load settings' : 'Loading...'}
            </p>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
