import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AnomalyDetectorSettingsResponse } from '@betterdb/shared';
import { anomalyDetectorsApi } from '../api/anomaly-detectors';

const QUERY_KEY = ['anomaly-detector-settings'] as const;

export function useAnomalyDetectorSettings(enabled: boolean) {
  const queryClient = useQueryClient();

  // Never refetch in the background: a refetch would replace `data` and the
  // panel would reset whatever the user is typing. The panel invalidates
  // explicitly after each of its own mutations.
  const { data, isLoading, error } = useQuery<AnomalyDetectorSettingsResponse, Error>({
    queryKey: QUERY_KEY,
    queryFn: anomalyDetectorsApi.get,
    enabled,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }, [queryClient]);

  return {
    data,
    loading: isLoading,
    error: error ?? null,
    invalidate,
  };
}
