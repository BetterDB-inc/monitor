import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  FT_SEARCH_HEALTHY_P50_THRESHOLD_US,
  Feature,
  type InferenceLatencyBucket,
  type InferenceLatencyProfile,
} from '@betterdb/shared';
import {
  getInferenceLatencyProfile,
  getInferenceLatencyTrend,
} from '../api/inference-latency';
import { settingsApi } from '../api/settings';
import { useCapabilities } from '../hooks/useCapabilities';
import { useConnection } from '../hooks/useConnection';
import { useLicense } from '../hooks/useLicense';
import { usePolling } from '../hooks/usePolling';
import { UnavailableOverlay } from '../components/UnavailableOverlay';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  DateRangePicker,
  type DateRange,
} from '../components/ui/date-range-picker';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../components/ui/tooltip';
import { formatDurationUs } from '../lib/utils';
import { InferenceSlaConfig } from '../components/inference/InferenceSlaConfig';
import { InferenceTrendChart } from '../components/inference/InferenceTrendChart';

const PROFILE_POLL_MS = 30_000;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const TREND_WINDOW_MS = 60 * 60 * 1000;
const TREND_BUCKET_MS = 60_000;
const TREND_POLL_MS = 60_000;

function bucketLabel(bucket: string): string {
  if (bucket.startsWith('FT.SEARCH:')) return bucket;
  if (bucket === 'read') return 'Session reads (GET / MGET)';
  if (bucket === 'write') return 'Session writes (SET / HSET family)';
  return bucket;
}

function sortBuckets(buckets: InferenceLatencyBucket[]): InferenceLatencyBucket[] {
  const ftSearch = buckets.filter((b) => b.bucket.startsWith('FT.SEARCH:'));
  const reads = buckets.filter((b) => b.bucket === 'read');
  const writes = buckets.filter((b) => b.bucket === 'write');
  return [...ftSearch.sort((a, b) => a.bucket.localeCompare(b.bucket)), ...reads, ...writes];
}

function BucketTile({ bucket }: { bucket: InferenceLatencyBucket }) {
  const borderClass = bucket.unhealthy
    ? 'border-destructive/60 bg-destructive/5'
    : 'border-border';
  const indexName = bucket.bucket.startsWith('FT.SEARCH:')
    ? bucket.bucket.slice('FT.SEARCH:'.length)
    : null;
  return (
    <Card className={borderClass}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base font-mono">
          <span className="truncate">{bucketLabel(bucket.bucket)}</span>
          <div className="flex items-center gap-2">
            {bucket.unhealthy ? (
              <Badge variant="destructive">unhealthy</Badge>
            ) : (
              <Badge variant="secondary">healthy</Badge>
            )}
            {indexName && (
              <InferenceSlaConfig
                indexName={indexName}
                trigger={
                  <Button type="button" variant="ghost" size="sm" aria-label="Configure SLA">
                    ⚙
                  </Button>
                }
              />
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="grid grid-cols-3 gap-2 text-sm">
          <div>
            <div className="text-muted-foreground text-xs">p50</div>
            <div className="font-mono">{formatDurationUs(bucket.p50)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">p95</div>
            <div className="font-mono">{formatDurationUs(bucket.p95)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">p99</div>
            <div className="font-mono">{formatDurationUs(bucket.p99)}</div>
          </div>
        </div>
        <div className="text-xs text-muted-foreground">{bucket.count.toLocaleString()} samples</div>
        {bucket.namedEvents.length > 0 && (
          <div className="text-xs text-amber-700 dark:text-amber-400">
            Latency degraded during indexing since{' '}
            {new Date(bucket.namedEvents[0].since).toLocaleTimeString()}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SourceAdvisory({ profile }: { profile: InferenceLatencyProfile }) {
  const thresholdFormatted = profile.thresholdUs > 0 ? formatDurationUs(profile.thresholdUs) : '—';
  return (
    <Alert>
      <AlertTitle>
        Percentiles sourced from{' '}
        <code className="px-1 py-0.5 bg-muted rounded text-xs">
          {profile.source === 'commandlog' ? 'command_log_entries' : 'slowlog_entries'}
        </code>
      </AlertTitle>
      <AlertDescription>
        Only entries slower than the active threshold directive{' '}
        <code className="px-1 py-0.5 bg-muted rounded text-xs">{profile.thresholdDirective}</code>{' '}
        (currently <strong>{thresholdFormatted}</strong>) are recorded, so percentiles skew toward
        the tail. A healthy p50 here reflects the slow-call distribution, not your full traffic.
      </AlertDescription>
    </Alert>
  );
}

interface Breach {
  indexName: string;
  currentP99Us: number;
  thresholdUs: number;
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

function BreachBanner({ breaches }: { breaches: Breach[] }) {
  if (breaches.length === 0) return null;
  return (
    <Alert variant="destructive">
      <AlertTitle>Active SLA breach{breaches.length === 1 ? '' : 'es'}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4 space-y-1">
          {breaches.map((b) => (
            <li key={b.indexName} className="font-mono text-sm">
              {b.indexName}: p99 {formatDurationUs(b.currentP99Us)} ≥ threshold{' '}
              {formatDurationUs(b.thresholdUs)}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function FtSearchTrendPanel({
  bucket,
  connectionId,
  dateRange,
}: {
  bucket: InferenceLatencyBucket;
  connectionId: string | undefined;
  dateRange: DateRange | undefined;
}) {
  const isCustom = dateRange !== undefined;
  const rangeKey = isCustom
    ? `${dateRange.from.getTime()}-${dateRange.to.getTime()}`
    : 'rolling';

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
  if (!query.data) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">Loading trend…</CardContent>
      </Card>
    );
  }

  const indexingBands = bucket.namedEvents.map((e) => ({
    start: e.since,
    end: Date.now(),
  }));

  return (
    <InferenceTrendChart
      trend={query.data}
      healthyThresholdUs={FT_SEARCH_HEALTHY_P50_THRESHOLD_US}
      indexingBands={indexingBands}
    />
  );
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
          <TooltipProvider delayDuration={100}>
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className="pointer-events-none opacity-60"
                  aria-disabled="true"
                  tabIndex={-1}
                >
                  {picker}
                </div>
              </TooltipTrigger>
              <TooltipContent>
                Historical ranges are a Pro feature. Community is locked to the live 15-minute
                window. Upgrade to query any past window.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      <BreachBanner breaches={activeBreaches} />

      {profile && <SourceAdvisory profile={profile} />}

      {profileQuery.loading && !profile ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Loading profile…
          </CardContent>
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
            <code className="px-1 py-0.5 bg-muted rounded text-xs">valkey-bundle</code>) or attach
            a connection that has it enabled.
          </>
        }
      >
        {content}
      </UnavailableOverlay>
    );
  }

  return content;
}
