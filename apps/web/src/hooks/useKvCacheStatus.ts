import { useQuery } from '@tanstack/react-query';
import { Feature, type KvCacheStatus } from '@betterdb/shared';
import { kvCacheApi, kvCacheKeys } from '../api/kv-cache';
import { useConnection } from './useConnection';
import { useLicense } from './useLicense';
import { hasKvCacheFootprint } from '../utils/connectionType';

const FIRST_SCAN_FAST_POLLS = 24;

export function useKvCacheStatus() {
  const { currentConnection } = useConnection();
  const { hasFeature } = useLicense();
  const connectionId = currentConnection?.id ?? null;

  return useQuery({
    queryKey: kvCacheKeys.status(connectionId),
    queryFn: ({ signal }) => kvCacheApi.getStatus(signal),
    enabled:
      hasFeature(Feature.KV_CACHE_MONITORING) &&
      connectionId !== null &&
      hasKvCacheFootprint(currentConnection),
    refetchInterval: (query) =>
      awaitingFirstScan(query.state.data) && query.state.dataUpdateCount < FIRST_SCAN_FAST_POLLS
        ? 5_000
        : 60_000,
  });
}

export const kvCacheInUse = (status: KvCacheStatus | undefined) =>
  !!status && (status.hasLmcache || status.engines.length > 0);

export const awaitingFirstScan = (status: KvCacheStatus | undefined) =>
  !!status && status.latest === null && !kvCacheInUse(status);
