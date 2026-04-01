import { useQuery } from '@tanstack/react-query';
import { metricsApi } from '../api/metrics';

interface UseStoredMemorySnapshotsOptions {
  connectionId?: string;
  startTime?: number;
  endTime?: number;
  enabled?: boolean;
  limit?: number;
}

export function useStoredMemorySnapshots({
  connectionId,
  startTime,
  endTime,
  enabled = true,
  limit = 500,
}: UseStoredMemorySnapshotsOptions) {
  return useQuery({
    queryKey: ['stored-memory-snapshots', connectionId, startTime, endTime, limit],
    queryFn: () => metricsApi.getStoredMemorySnapshots({ startTime, endTime, limit }),
    enabled: enabled && startTime !== undefined && endTime !== undefined,
  });
}
