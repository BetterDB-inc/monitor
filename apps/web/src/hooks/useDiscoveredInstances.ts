import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DiscoveredInstance, DiscoveredInstancesResponse } from '@betterdb/shared';
import { fetchApi } from '../api/client';

const QUERY_KEY = ['discovered-instances'] as const;
const REFETCH_INTERVAL_MS = 30_000;

export function useDiscoveredInstances(enabled: boolean) {
  const queryClient = useQueryClient();

  const { data } = useQuery<DiscoveredInstancesResponse, Error>({
    queryKey: QUERY_KEY,
    queryFn: () => fetchApi<DiscoveredInstancesResponse>('/connections/discovered'),
    enabled,
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }, [queryClient]);

  const dismiss = useCallback(
    async (instance: DiscoveredInstance) => {
      queryClient.setQueryData<DiscoveredInstancesResponse>(QUERY_KEY, (previous) =>
        previous
          ? {
              ...previous,
              instances: previous.instances.filter(
                (item) => !(item.host === instance.host && item.port === instance.port),
              ),
            }
          : previous,
      );
      try {
        await fetchApi<void>('/connections/discovered/dismiss', {
          method: 'POST',
          body: JSON.stringify({ host: instance.host, port: instance.port }),
        });
      } finally {
        await invalidate();
      }
    },
    [queryClient, invalidate],
  );

  return {
    instances: enabled && data?.enabled ? data.instances : [],
    dismiss,
    invalidate,
  };
}
