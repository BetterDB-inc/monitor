import { useQueryClient } from '@tanstack/react-query';
import { kvCacheKeys } from '../../../api/kv-cache';
import { useConnection } from '../../../hooks/useConnection';

export function useInvalidateEngines() {
  const queryClient = useQueryClient();
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id ?? null;
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: kvCacheKeys.status(connectionId) }),
      queryClient.invalidateQueries({ queryKey: kvCacheKeys.engines(connectionId) }),
      queryClient.invalidateQueries({ queryKey: ['kv-cache', 'samples', connectionId] }),
    ]);
}
