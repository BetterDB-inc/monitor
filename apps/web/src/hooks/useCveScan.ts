import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { CveDatasetStatus, CveScanResult } from '@betterdb/shared';
import { getCurrentConnectionId } from '../api/client';
import { fetchCveDataset, fetchCveScan, refreshCveScan } from '../api/cve';

const SCAN_STALE_MS = 5 * 60 * 1000;

const queryKeys = {
  scan: (connectionId: string | null) => ['cve', 'scan', connectionId] as const,
  dataset: (connectionId: string | null) => ['cve', 'dataset', connectionId] as const,
};

export function useCveScan(): UseQueryResult<CveScanResult, Error> {
  return useQuery<CveScanResult, Error>({
    queryKey: queryKeys.scan(getCurrentConnectionId()),
    queryFn: fetchCveScan,
    staleTime: SCAN_STALE_MS,
  });
}

export function useCveDataset(): UseQueryResult<CveDatasetStatus, Error> {
  return useQuery<CveDatasetStatus, Error>({
    queryKey: queryKeys.dataset(getCurrentConnectionId()),
    queryFn: fetchCveDataset,
    staleTime: SCAN_STALE_MS,
  });
}

export function useRefreshCveScan(): UseMutationResult<CveScanResult, Error, void> {
  const queryClient = useQueryClient();
  const connectionId = getCurrentConnectionId();

  return useMutation<CveScanResult, Error, void>({
    mutationFn: refreshCveScan,
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.scan(connectionId), result);
      void queryClient.invalidateQueries({ queryKey: queryKeys.dataset(connectionId) });
    },
  });
}
