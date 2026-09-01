import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { CveDatasetStatus, CveScanResult } from '@betterdb/shared';
import { fetchCveDataset, fetchCveScan, refreshCveScan } from '../api/cve';
import { useConnection } from './useConnection';

const SCAN_STALE_MS = 5 * 60 * 1000;

const queryKeys = {
  scan: (connectionId: string | null) => ['cve', 'scan', connectionId] as const,
  dataset: (connectionId: string | null) => ['cve', 'dataset', connectionId] as const,
};

export function useCveScan(): UseQueryResult<CveScanResult, Error> {
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id ?? null;

  return useQuery<CveScanResult, Error>({
    queryKey: queryKeys.scan(connectionId),
    queryFn: fetchCveScan,
    staleTime: SCAN_STALE_MS,
    enabled: !!connectionId,
  });
}

export function useCveDataset(): UseQueryResult<CveDatasetStatus, Error> {
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id ?? null;

  return useQuery<CveDatasetStatus, Error>({
    queryKey: queryKeys.dataset(connectionId),
    queryFn: fetchCveDataset,
    staleTime: SCAN_STALE_MS,
    enabled: !!connectionId,
  });
}

export function useRefreshCveScan(): UseMutationResult<CveScanResult, Error, void> {
  const queryClient = useQueryClient();

  return useMutation<CveScanResult, Error, void>({
    mutationFn: refreshCveScan,
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.scan(result.connectionId), result);
      void queryClient.invalidateQueries({ queryKey: queryKeys.dataset(result.connectionId) });
    },
  });
}
