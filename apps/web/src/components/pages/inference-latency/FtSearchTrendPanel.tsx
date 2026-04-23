import type { DateRange } from '@/components/ui/date-range-picker.tsx';
import { usePolling } from '@/hooks/usePolling.ts';
import { FT_SEARCH_HEALTHY_P50_THRESHOLD_US, InferenceLatencyBucket } from '@betterdb/shared';
import { getInferenceLatencyTrend } from '@/api/inference-latency.ts';
import { Card, CardContent } from '@/components/ui/card.tsx';
import { InferenceTrendChart } from '@/components/inference/InferenceTrendChart.tsx';

const TREND_WINDOW_MS = 60 * 60 * 1000;
const TREND_BUCKET_MS = 60_000;
const TREND_POLL_MS = 60_000;

export function FtSearchTrendPanel({
  bucket,
  connectionId,
  dateRange,
}: {
  bucket: InferenceLatencyBucket;
  connectionId: string | undefined;
  dateRange: DateRange | undefined;
}) {
  const isCustom = dateRange !== undefined;
  const rangeKey = isCustom ? `${dateRange.from.getTime()}-${dateRange.to.getTime()}` : 'rolling';

  const query = usePolling({
    fetcher: () => {
      const end = isCustom ? dateRange.to.getTime() : Date.now();
      const start = isCustom ? dateRange.from.getTime() : end - TREND_WINDOW_MS;
      return getInferenceLatencyTrend(bucket.bucket, start, end, TREND_BUCKET_MS);
    },
    interval: isCustom ? 0 : TREND_POLL_MS,
    refetchKey: `${connectionId ?? 'default'}|${bucket.bucket}|${rangeKey}`,
  });

  if (query.error) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          Trend unavailable: {query.error.message}
        </CardContent>
      </Card>
    );
  }
  const trend = query.data;
  if (!trend) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">Loading trend…</CardContent>
      </Card>
    );
  }

  const indexingBands = bucket.namedEvents.map((e) => ({
    start: e.since,
    end: trend.endTime,
  }));

  return (
    <InferenceTrendChart
      trend={trend}
      healthyThresholdUs={FT_SEARCH_HEALTHY_P50_THRESHOLD_US}
      indexingBands={indexingBands}
    />
  );
}
