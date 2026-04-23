import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Feature, type InferenceLatencyBucket, InferenceLatencyProfile } from '@betterdb/shared';
import { getInferenceLatencyProfile } from '../api/inference-latency';
import { settingsApi } from '../api/settings';
import { useCapabilities } from '../hooks/useCapabilities';
import { useConnection } from '../hooks/useConnection';
import { useLicense } from '../hooks/useLicense';
import { usePolling } from '../hooks/usePolling';
import { UnavailableOverlay } from '../components/UnavailableOverlay';
import { Card, CardContent } from '../components/ui/card';
import { type DateRange, DateRangePicker } from '../components/ui/date-range-picker';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { BucketTile } from '@/components/pages/inference-latency/BucketTile.tsx';
import { SourceAdvisory } from '@/components/pages/inference-latency/SourceAdvisory.tsx';
import { Breach, BreachBanner } from '@/components/pages/inference-latency/BreachBanner.tsx';
import { FtSearchTrendPanel } from '@/components/pages/inference-latency/FtSearchTrendPanel.tsx';

const PROFILE_POLL_MS = 30_000;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

function sortBuckets(buckets: InferenceLatencyBucket[]): InferenceLatencyBucket[] {
  const ftSearch: InferenceLatencyBucket[] = [];
  const reads: InferenceLatencyBucket[] = [];
  const writes: InferenceLatencyBucket[] = [];
  buckets.forEach((b) => {
    if (b.bucket.startsWith('FT.SEARCH:')) {
      ftSearch.push(b);
      return;
    }
    if (b.bucket === 'read') {
      reads.push(b);
      return;
    }
    if (b.bucket === 'write') {
      writes.push(b);
      return;
    }
  });

  return [
    ...ftSearch.sort((a, b) => {
      return a.bucket.localeCompare(b.bucket);
    }),
    ...reads,
    ...writes,
  ];
}

function deriveActiveBreaches(
  profile: InferenceLatencyProfile | null,
  slaConfig: Record<string, { p99ThresholdUs: number; enabled: boolean }> | undefined,
): Breach[] {
  if (!profile || !slaConfig) return [];
  const breaches: Breach[] = [];
  for (const bucket of profile.buckets) {
    if (!bucket.bucket.startsWith('FT.SEARCH:')) continue;
    const indexName = bucket.bucket.slice('FT.SEARCH:'.length);
    const config = slaConfig[indexName];
    if (!config?.enabled) continue;
    if (bucket.p99 >= config.p99ThresholdUs) {
      breaches.push({ indexName, currentP99Us: bucket.p99, thresholdUs: config.p99ThresholdUs });
    }
  }
  return breaches;
}

export function InferenceLatency() {
  const { hasVectorSearch } = useCapabilities();
  const { currentConnection } = useConnection();
  const { hasFeature } = useLicense();
  const canUseHistorical = hasFeature(Feature.INFERENCE_SLA);
  const canSeeTrend = canUseHistorical;
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);
  // Community is locked to the live rolling window — ignore any stale state.
  const effectiveRange = canUseHistorical ? dateRange : undefined;
  const isCustomRange = effectiveRange !== undefined;
  const profileWindowMs = isCustomRange
    ? Math.max(1_000, effectiveRange.to.getTime() - effectiveRange.from.getTime())
    : DEFAULT_WINDOW_MS;
  const rangeKey = isCustomRange
    ? `${effectiveRange.from.getTime()}-${effectiveRange.to.getTime()}`
    : 'rolling';

  const profileQuery = usePolling({
    fetcher: () => getInferenceLatencyProfile({ windowMs: profileWindowMs }),
    interval: isCustomRange ? 0 : PROFILE_POLL_MS,
    enabled: hasVectorSearch,
    refetchKey: `${currentConnection?.id ?? 'default'}|${rangeKey}`,
  });

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.getSettings(),
    enabled: hasVectorSearch,
  });

  const profile = profileQuery.data ?? null;
  const buckets = useMemo(() => (profile ? sortBuckets(profile.buckets) : []), [profile]);
  const hasFtSearchBuckets = buckets.some((b) => b.bucket.startsWith('FT.SEARCH:'));
  const activeBreaches = useMemo(
    () => deriveActiveBreaches(profile, settingsQuery.data?.settings.inferenceSlaConfig),
    [profile, settingsQuery.data],
  );

  const picker = (
    <DateRangePicker
      value={effectiveRange}
      onChange={setDateRange}
      placeholder={canUseHistorical ? 'Last 15 minutes (live)' : 'Last 15 minutes (Pro required)'}
    />
  );

  const content = (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Inference Latency</h1>
          <p className="text-muted-foreground">
            Per-bucket p50 / p95 / p99 across the inference hot path — FT.SEARCH indexes plus
            aggregate session reads and writes.
          </p>
        </div>
        {canUseHistorical ? (
          picker
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="inline-block cursor-not-allowed opacity-60"
                aria-disabled="true"
                tabIndex={0}
              >
                <div className="pointer-events-none select-none">{picker}</div>
              </div>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-xs">
              Historical ranges are a Pro feature. Community is locked to the live 15-minute window.
              Upgrade to query any past window.
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <BreachBanner breaches={activeBreaches} />

      {profile && <SourceAdvisory profile={profile} />}

      {profileQuery.loading && !profile ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">Loading profile…</CardContent>
        </Card>
      ) : buckets.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            {isCustomRange
              ? 'No entries in the selected range.'
              : 'No entries in the current window. Data appears after the first poll captures slow traffic; if your threshold directive is set high, you may need traffic exceeding it before any bucket appears.'}
          </CardContent>
        </Card>
      ) : (
        <>
          {hasFtSearchBuckets && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold">Vector search</h2>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {buckets
                  .filter((b) => b.bucket.startsWith('FT.SEARCH:'))
                  .map((b) => (
                    <BucketTile key={b.bucket} bucket={b} />
                  ))}
              </div>
              {canSeeTrend && (
                <div className="grid gap-4 md:grid-cols-2">
                  {buckets
                    .filter((b) => b.bucket.startsWith('FT.SEARCH:'))
                    .map((b) => (
                      <FtSearchTrendPanel
                        key={`trend-${b.bucket}`}
                        bucket={b}
                        connectionId={currentConnection?.id}
                        dateRange={effectiveRange}
                      />
                    ))}
                </div>
              )}
            </div>
          )}
          <div>
            <h2 className="text-xl font-semibold mb-3">Session state</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {buckets
                .filter((b) => !b.bucket.startsWith('FT.SEARCH:'))
                .map((b) => (
                  <BucketTile key={b.bucket} bucket={b} />
                ))}
              {!buckets.some((b) => !b.bucket.startsWith('FT.SEARCH:')) && (
                <Card>
                  <CardContent className="p-6 text-sm text-muted-foreground">
                    No session-state entries (GET / MGET / SET / HSET family) above the threshold in
                    the current window.
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );

  if (!hasVectorSearch) {
    return (
      <UnavailableOverlay
        featureName="Inference Latency"
        command="FT._LIST"
        description={
          <>
            The Valkey/Redis Search module is not available on this connection, so the profiler has
            no inference workload to analyse. Load the Search module (e.g.{' '}
            <code className="px-1 py-0.5 bg-muted rounded text-xs">valkey-bundle</code>) or attach a
            connection that has it enabled.
          </>
        }
      >
        {content}
      </UnavailableOverlay>
    );
  }

  return content;
}
