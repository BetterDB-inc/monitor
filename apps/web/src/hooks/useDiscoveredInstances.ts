import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DiscoveredInstance, DiscoveredInstancesResponse } from '@betterdb/shared';
import { fetchApi } from '../api/client';

const QUERY_KEY = ['discovered-instances'] as const;
const REFETCH_INTERVAL_MS = 30_000;

export function useDiscoveredInstances(enabled: boolean) {
  const queryClient = useQueryClient();
  const [dismissError, setDismissError] = useState<string | null>(null);

  const { data } = useQuery<DiscoveredInstancesResponse, Error>({
    queryKey: QUERY_KEY,
    queryFn: () => fetchApi<DiscoveredInstancesResponse>('/connections/discovered'),
    enabled,
    refetchInterval: (query) => (query.state.data?.enabled === false ? false : REFETCH_INTERVAL_MS),
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
        setDismissError(null);
      } catch (error) {
        setDismissError(error instanceof Error ? error.message : 'Failed to dismiss instance');
        throw error;
      } finally {
        await invalidate();
      }
    },
    [queryClient, invalidate],
  );

  return {
    instances: enabled && data?.enabled ? data.instances : [],
    dismiss,
    dismissError,
    invalidate,
  };
}
