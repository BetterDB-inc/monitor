import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import { PaymentRequiredError } from '../api/client';
import { useUpgradePrompt } from './useUpgradePrompt';

interface UsePollingOptions<T> {
  fetcher: (signal: AbortSignal) => Promise<T>;
  interval?: number;
  enabled?: boolean;
  /** Optional key that triggers a refetch when changed (e.g., filter parameters) */
  refetchKey?: string | number;
  /** Query key — provide explicitly to share cache across components. */
  queryKey?: readonly unknown[];
}

let keyCounter = 0;

export function usePolling<T>({
  fetcher,
  interval = 5000,
  enabled = true,
  refetchKey,
  queryKey,
}: UsePollingOptions<T>) {
  const { showUpgradePrompt } = useUpgradePrompt();
  const queryClient = useQueryClient();
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Stable key per hook instance, won't change across renders
  const stableKeyRef = useRef<number | null>(null);
  if (stableKeyRef.current === null) {
    stableKeyRef.current = ++keyCounter;
  }

  const resolvedKey = queryKey ?? ['polling', stableKeyRef.current, refetchKey];

  const { data, error, isLoading, dataUpdatedAt } = useQuery<T, Error>({
    queryKey: resolvedKey,
    queryFn: async ({ signal }) => {
      try {
        return await fetcherRef.current(signal);
      } catch (e) {
        if (e instanceof PaymentRequiredError) {
          showUpgradePrompt(e);
        }
        throw e;
      }
    },
    enabled,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: resolvedKey });
  }, [queryClient, resolvedKey]);

  const lastUpdated = dataUpdatedAt ? new Date(dataUpdatedAt) : null;

  return { data: data ?? null, error, loading: isLoading, lastUpdated, refresh };
}
