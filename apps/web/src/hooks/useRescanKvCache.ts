import { useMutation, useQueryClient } from '@tanstack/react-query';
import { kvCacheApi, kvCacheKeys } from '../api/kv-cache';
import { useConnection } from './useConnection';

export function useRescanKvCache() {
  const queryClient = useQueryClient();
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id ?? null;

  return useMutation({
    mutationFn: () => kvCacheApi.refreshFootprint(),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: kvCacheKeys.status(connectionId) }),
        queryClient.invalidateQueries({ queryKey: kvCacheKeys.historyAll(connectionId) }),
      ]),
  });
}
