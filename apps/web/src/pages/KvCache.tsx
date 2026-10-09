import { useMutation, useQueryClient } from '@tanstack/react-query';
import { kvCacheApi, kvCacheKeys } from '../api/kv-cache';
import { useConnection } from '../hooks/useConnection';
import { Button } from '../components/ui/button';

export function KvCache() {
  const queryClient = useQueryClient();
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id ?? null;

  const refresh = useMutation({
    mutationFn: () => kvCacheApi.refreshFootprint(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: kvCacheKeys.status(connectionId) }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">KV Cache</h1>
        <Button variant="outline" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          Refresh
        </Button>
      </div>
    </div>
  );
}
