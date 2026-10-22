import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { kvCacheApi, kvCacheKeys } from '../api/kv-cache';
import { useCanEditKvCache } from '../hooks/useCanEditKvCache';
import { useConnection } from '../hooks/useConnection';
import { useKvCacheStatus } from '../hooks/useKvCacheStatus';
import { useRescanKvCache } from '../hooks/useRescanKvCache';
import { Button } from '../components/ui/button';
import { DateRangePicker, type DateRange } from '../components/ui/date-range-picker';
import {
  KvCacheAdvisories,
  KvCacheCards,
  KvCacheCharts,
  KvCacheEngines,
  KvCacheModelTable,
  KvCacheSettingsSheet,
  advisoriesFor,
  samplesStartedAfter,
} from '../components/pages/kv-cache';

const DEFAULT_RANGE_MS = 6 * 60 * 60 * 1000;
const RECENT_HIT_RATE_MS = 15 * 60 * 1000;
const POLL_MS = 60_000;

export function chartRefetchInterval(
  range: DateRange | undefined,
  now: number,
  intervalMs: number = POLL_MS,
): number | false {
  if (!range) return intervalMs;
  return range.to.getTime() > now ? intervalMs : false;
}

export function isReversedRange(range: DateRange | undefined): boolean {
  return !!range && range.to.getTime() < range.from.getTime();
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? `: ${error.message}` : '';
}

export function KvCache() {
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id ?? null;
  const status = useKvCacheStatus();
  const rescan = useRescanKvCache();
  const canMutate = useCanEditKvCache();
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);

  const reversed = isReversedRange(dateRange);
  const from = dateRange?.from?.getTime();
  const to = dateRange?.to?.getTime();
  const engines = status.data?.engines ?? [];
  const hasEngines = engines.length > 0;
  const footprintIntervalMs = status.data?.footprintIntervalMs ?? POLL_MS;
  const samplesRefetchInterval = chartRefetchInterval(dateRange, Date.now());
  const historyRefetchInterval = chartRefetchInterval(dateRange, Date.now(), footprintIntervalMs);
  const historyEnabled = connectionId !== null && dateRange !== undefined && !reversed;
  const samplesEnabled = connectionId !== null && hasEngines && !reversed;
  const liveHistoryEnabled = connectionId !== null && dateRange === undefined;
  const recentEnabled = connectionId !== null && hasEngines;
  const range = () => {
    const end = to ?? Date.now();
    return { from: from ?? end - DEFAULT_RANGE_MS, to: end };
  };

  const history = useQuery({
    queryKey: kvCacheKeys.history(connectionId, from ?? 0, to ?? 0),
    queryFn: ({ signal }) => {
      const { from: start, to: end } = range();
      return kvCacheApi.getFootprintHistory(start, end, signal);
    },
    enabled: historyEnabled,
    refetchInterval: historyRefetchInterval,
  });

  const samples = useQuery({
    queryKey: kvCacheKeys.samples(connectionId, { from: from ?? 0, to: to ?? 0 }),
    queryFn: ({ signal }) => kvCacheApi.getSamples(range(), signal),
    enabled: samplesEnabled,
    refetchInterval: samplesRefetchInterval,
  });

  const liveHistory = useQuery({
    queryKey: kvCacheKeys.liveHistory(connectionId),
    queryFn: ({ signal }) => {
      const end = Date.now();
      return kvCacheApi.getFootprintHistory(end - DEFAULT_RANGE_MS, end, signal);
    },
    enabled: liveHistoryEnabled,
    refetchInterval: footprintIntervalMs,
  });

  const recent = useQuery({
    queryKey: kvCacheKeys.samples(connectionId, { recent: RECENT_HIT_RATE_MS }),
    queryFn: ({ signal }) => {
      const end = Date.now();
      return kvCacheApi.getSamples({ from: end - RECENT_HIT_RATE_MS, to: end }, signal);
    },
    enabled: recentEnabled,
    refetchInterval: POLL_MS,
  });

  const latest = status.data?.latest ?? null;
  const buckets = samples.data?.buckets ?? [];
  const chartHistory = (dateRange ? history.data : liveHistory.data) ?? [];
  const samplesSince = samplesStartedAfter(buckets, range().from);
  const dataError = [
    { query: history, enabled: historyEnabled },
    { query: liveHistory, enabled: liveHistoryEnabled },
    { query: samples, enabled: samplesEnabled },
    { query: recent, enabled: recentEnabled },
  ].find(({ query, enabled }) => enabled && query.isError)?.query.error;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">KV Cache</h1>
        <div className="flex items-center gap-3">
          <DateRangePicker value={dateRange} onChange={setDateRange} placeholder="Last 6 hours" />
          {canMutate && (
            <>
              <KvCacheSettingsSheet />
              <Button variant="outline" onClick={() => rescan.mutate()} disabled={rescan.isPending}>
                Refresh
              </Button>
            </>
          )}
        </div>
      </div>
      {rescan.isError && (
        <p className="text-sm text-destructive">
          Could not refresh
          {errorMessage(rescan.error)}
        </p>
      )}
      {reversed && (
        <p className="text-sm text-destructive">The end of the selected range is before its start.</p>
      )}
      {!reversed && dataError !== undefined && (
        <p className="text-sm text-destructive">Could not load KV cache data{errorMessage(dataError)}</p>
      )}
      {(latest || engines.length > 0) && (
        <>
          <KvCacheCards
            latest={latest}
            history={status.data?.recent ?? []}
            engines={engines}
            recentHitRate={recent.data?.rangeHitRate ?? null}
            recentBuckets={recent.data?.buckets ?? []}
          />
          {latest && <KvCacheAdvisories advisories={advisoriesFor(latest)} />}
          {samplesSince !== null && (
            <p className="text-xs text-muted-foreground">
              Showing engine data since {new Date(samplesSince).toLocaleString()}
            </p>
          )}
          <KvCacheCharts
            buckets={buckets}
            bucketMs={samples.data?.bucketMs}
            history={chartHistory}
            engines={engines}
          />
          {latest && <KvCacheModelTable latest={latest} buckets={buckets} />}
        </>
      )}
      <KvCacheEngines engines={engines} />
    </div>
  );
}
