import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { kvCacheApi, kvCacheKeys } from '../api/kv-cache';
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
} from '../components/pages/kv-cache';

const DEFAULT_RANGE_MS = 6 * 60 * 60 * 1000;
const RECENT_HIT_RATE_MS = 15 * 60 * 1000;

export function KvCache() {
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id ?? null;
  const status = useKvCacheStatus();
  const rescan = useRescanKvCache();
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);

  const from = dateRange?.from?.getTime();
  const to = dateRange?.to?.getTime();
  const refetchInterval = dateRange ? false : 60_000;
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
    enabled: connectionId !== null,
    refetchInterval,
  });

  const samples = useQuery({
    queryKey: kvCacheKeys.samples(connectionId, { from: from ?? 0, to: to ?? 0 }),
    queryFn: ({ signal }) => kvCacheApi.getSamples(range(), signal),
    enabled: connectionId !== null,
    refetchInterval,
  });

  const recent = useQuery({
    queryKey: kvCacheKeys.samples(connectionId, { recent: RECENT_HIT_RATE_MS }),
    queryFn: ({ signal }) => {
      const end = Date.now();
      return kvCacheApi.getSamples({ from: end - RECENT_HIT_RATE_MS, to: end }, signal);
    },
    enabled: connectionId !== null,
    refetchInterval: 60_000,
  });

  const latest = status.data?.latest ?? null;
  const engines = status.data?.engines ?? [];
  const buckets = samples.data?.buckets ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">KV Cache</h1>
        <div className="flex items-center gap-3">
          <DateRangePicker value={dateRange} onChange={setDateRange} placeholder="Last 6 hours" />
          <KvCacheSettingsSheet />
          <Button variant="outline" onClick={() => rescan.mutate()} disabled={rescan.isPending}>
            Refresh
          </Button>
        </div>
      </div>
      {latest && (
        <>
          <KvCacheCards
            latest={latest}
            history={history.data ?? []}
            engines={engines}
            recentHitRate={recent.data?.rangeHitRate ?? null}
            buckets={buckets}
          />
          <KvCacheAdvisories advisories={advisoriesFor(latest)} />
          <KvCacheCharts buckets={buckets} history={history.data ?? []} engines={engines} />
          <KvCacheModelTable latest={latest} buckets={buckets} />
        </>
      )}
      <KvCacheEngines engines={engines} />
    </div>
  );
}
