import { useState, useEffect, useRef } from 'react';
import { PaymentRequiredError } from '../api/client';
import { useUpgradePrompt } from './useUpgradePrompt';

interface UsePollingOptions<T> {
  fetcher: ((signal?: AbortSignal) => Promise<T>) | ((...args: any[]) => Promise<T>);
  interval?: number;
  enabled?: boolean;
  /** Optional key that triggers a refetch when changed (e.g., filter parameters) */
  refetchKey?: string | number;
}

export function usePolling<T>({ fetcher, interval = 5000, enabled = true, refetchKey }: UsePollingOptions<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const fetcherRef = useRef(fetcher);
  const abortControllerRef = useRef<AbortController | null>(null);
  const { showUpgradePrompt } = useUpgradePrompt();

  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const refresh = async () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        setError(null);
        const result = await (fetcherRef.current as (signal?: AbortSignal) => Promise<T>)(abortController.signal);

        if (!abortController.signal.aborted) {
          setData(result);
          setLastUpdated(new Date());
        }
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
          return;
        }

        if (e instanceof PaymentRequiredError) {
          showUpgradePrompt(e);
          setError(e);
          return;
        }
        setError(e instanceof Error ? e : new Error('Unknown error'));
      } finally {
        if (!abortController.signal.aborted) {
          setLoading(false);
        }
      }
    };

    refresh();
    const timer = setInterval(refresh, interval);

    return () => {
      clearInterval(timer);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [interval, enabled, showUpgradePrompt, refetchKey]);

  const manualRefresh = async () => {
    try {
      setError(null);
      const result = await fetcherRef.current();
      setData(result);
      setLastUpdated(new Date());
    } catch (e) {
      if (e instanceof PaymentRequiredError) {
        showUpgradePrompt(e);
        setError(e);
        return;
      }
      setError(e instanceof Error ? e : new Error('Unknown error'));
    }
  };

  return { data, error, loading, lastUpdated, refresh: manualRefresh };
}
