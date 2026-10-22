import { useQueryClient } from '@tanstack/react-query';
import { kvCacheKeys } from '../../../api/kv-cache';
import { useConnection } from '../../../hooks/useConnection';

export interface EngineMutationContext {
  connectionId: string | null;
}

export function useInvalidateEngines() {
  const queryClient = useQueryClient();
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id ?? null;
  return {
    capture: (): EngineMutationContext => ({ connectionId }),
    invalidate: (context: EngineMutationContext | undefined) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: kvCacheKeys.status(context?.connectionId ?? null) }),
        queryClient.invalidateQueries({ queryKey: kvCacheKeys.samplesAll(context?.connectionId ?? null) }),
      ]),
  };
}
