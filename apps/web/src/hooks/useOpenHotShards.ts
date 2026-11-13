import { metricsApi } from '../api/metrics';
import type { HotShardDetail } from '../types/anomaly';
import { usePolling } from './usePolling';

const OPEN_EVENTS_POLL_MS = 5000;
const HOT_SHARDS_POLL_MS = 10000;

export function useOpenHotShards(connectionId: string | undefined): HotShardDetail[] {
  const { data: openEvents, error: eventsError } = usePolling({
    fetcher: () => metricsApi.getAnomalyEvents({ metricType: 'hot_shard', activeOnly: true }),
    interval: OPEN_EVENTS_POLL_MS,
    enabled: !!connectionId,
    queryKey: ['open-hot-shard-events', connectionId],
  });
  const openIds = new Set(
    (openEvents ?? [])
      .filter((event) => event.metricType === 'hot_shard' && !event.resolved)
      .map((event) => event.id),
  );
  const { data: hotShards, error: hotShardsError } = usePolling<HotShardDetail[]>({
    fetcher: () => metricsApi.getHotShards(),
    interval: HOT_SHARDS_POLL_MS,
    enabled: openIds.size > 0 && !!connectionId,
    queryKey: ['open-hot-shards', connectionId],
  });
  if (!connectionId || eventsError || hotShardsError) return [];
  return (hotShards ?? []).filter((shard) => openIds.has(shard.eventId));
}
