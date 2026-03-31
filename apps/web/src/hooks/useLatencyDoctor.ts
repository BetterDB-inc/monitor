import { useQuery } from '@tanstack/react-query';
import { metricsApi } from '../api/metrics';

export function useLatencyDoctor(connectionId?: string) {
  return useQuery({
    queryKey: ['latency-doctor', connectionId],
    queryFn: async () => {
      const data = await metricsApi.getLatencyDoctor();
      return data.report;
    },
  });
}
