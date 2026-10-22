import { useMutation, useQueryClient } from '@tanstack/react-query';
import { kvCacheApi, kvCacheKeys } from '../api/kv-cache';
import { useConnection } from './useConnection';

export function useRescanKvCache() {
  const queryClient = useQueryClient();
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id ?? null;

  return useMutation({
    mutationFn: () => kvCacheApi.refreshFootprint(),
    onMutate: () => ({ connectionId }),
    onSuccess: (_data, _variables, context) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: kvCacheKeys.status(context.connectionId) }),
        queryClient.invalidateQueries({ queryKey: kvCacheKeys.historyAll(context.connectionId) }),
      ]),
  });
}
