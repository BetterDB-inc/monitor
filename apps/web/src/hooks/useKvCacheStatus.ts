import { useQuery } from '@tanstack/react-query';
import { Feature } from '@betterdb/shared';
import { kvCacheApi, kvCacheKeys } from '../api/kv-cache';
import { useConnection } from './useConnection';
import { useLicense } from './useLicense';

export function useKvCacheStatus() {
  const { currentConnection } = useConnection();
  const { hasFeature } = useLicense();
  const connectionId = currentConnection?.id ?? null;

  return useQuery({
    queryKey: kvCacheKeys.status(connectionId),
    queryFn: ({ signal }) => kvCacheApi.getStatus(signal),
    enabled: hasFeature(Feature.KV_CACHE_MONITORING) && connectionId !== null,
    refetchInterval: 60_000,
  });
}
