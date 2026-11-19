import { useMemo } from 'react';
import { usePolling } from './usePolling';
import { metricsApi } from '../api/metrics';
import { nodeCollectionOf } from '../components/cluster/nodeCollection';

export function useNodeCollection(connectionId: string | undefined, enabled: boolean) {
  const { data, refresh } = usePolling({
    fetcher: (signal?: AbortSignal) => metricsApi.discoverClusterNodes(signal),
    interval: 30000,
    enabled,
    refetchKey: connectionId,
  });
  const collection = useMemo(() => nodeCollectionOf(data), [data]);
  return { collection, refresh };
}
