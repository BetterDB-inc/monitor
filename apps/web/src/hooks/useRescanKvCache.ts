import { useMutation, useQueryClient } from '@tanstack/react-query';
import { kvCacheApi, kvCacheKeys } from '../api/kv-cache';
import { useConnection } from './useConnection';

export function useRescanKvCache() {
  const queryClient = useQueryClient();
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id ?? null;

  return useMutation({
    mutationFn: () => kvCacheApi.refreshFootprint(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: kvCacheKeys.status(connectionId) }),
  });
}
