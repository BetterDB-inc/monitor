import { useQuery } from '@tanstack/react-query';
import { metricsApi } from '../api/metrics';

export function useLatencyHistory(selectedEvent: string | null, connectionId?: string) {
  return useQuery({
    queryKey: ['latency-history', connectionId, selectedEvent],
    queryFn: () => metricsApi.getLatencyHistory(selectedEvent!),
    enabled: !!selectedEvent,
  });
}
