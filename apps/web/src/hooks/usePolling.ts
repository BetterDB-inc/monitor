import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef } from 'react';
import { PaymentRequiredError } from '../api/client';
import { useUpgradePrompt } from './useUpgradePrompt';

interface UsePollingOptions<T> {
  fetcher: (signal: AbortSignal) => Promise<T>;
  interval?: number | ((data: T | undefined, error: Error | null) => number | false);
  shouldRetry?: (error: Error) => boolean;
  enabled?: boolean;
  /** Optional key that triggers a refetch when changed (e.g., filter parameters) */
  refetchKey?: string | number;
  /** Query key — provide explicitly to share cache across components. */
  queryKey?: readonly unknown[];
  keepPreviousDataFor?: string;
}

let keyCounter = 0;

export function usePolling<T>({
  fetcher,
  interval = 5000,
  shouldRetry,
  enabled = true,
  refetchKey,
  queryKey,
  keepPreviousDataFor,
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

  const resolvedKey = useMemo(
    () => queryKey ?? ['polling', stableKeyRef.current, refetchKey],
    [queryKey, refetchKey],
  );

  const { data, error, isLoading, isPlaceholderData, dataUpdatedAt } = useQuery<T, Error>({
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
    meta: { keepPreviousDataFor },
    placeholderData: (previous, previousQuery) =>
      keepPreviousDataFor !== undefined &&
      previousQuery?.meta?.keepPreviousDataFor === keepPreviousDataFor
        ? previous
        : undefined,
    refetchInterval:
      typeof interval === 'function'
        ? (query) => interval(query.state.data, query.state.error)
        : interval,
    refetchIntervalInBackground: false,
    retry: (failureCount, error) => {
      if (error instanceof PaymentRequiredError) return false;
      if (shouldRetry && !shouldRetry(error)) return false;
      return failureCount < 1;
    },
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: resolvedKey });
  }, [queryClient, resolvedKey]);

  const lastUpdated = dataUpdatedAt ? new Date(dataUpdatedAt) : null;

  return {
    data: data ?? null,
    error,
    loading: enabled ? isLoading : false,
    isPlaceholder: enabled ? isPlaceholderData : false,
    lastUpdated,
    refresh,
  };
}
