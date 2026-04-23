import { useMemo } from 'react';
import type { InferenceLatencyBucket, InferenceLatencyProfile } from '@betterdb/shared';
import { getInferenceLatencyProfile } from '../api/inference-latency';
import { useCapabilities } from '../hooks/useCapabilities';
import { useConnection } from '../hooks/useConnection';
import { usePolling } from '../hooks/usePolling';
import { UnavailableOverlay } from '../components/UnavailableOverlay';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { formatDurationUs } from '../lib/utils';

const PROFILE_POLL_MS = 30_000;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

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
  return (
    <Card className={borderClass}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base font-mono">
          <span className="truncate">{bucketLabel(bucket.bucket)}</span>
          {bucket.unhealthy ? (
            <Badge variant="destructive">unhealthy</Badge>
          ) : (
            <Badge variant="secondary">healthy</Badge>
          )}
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

export function InferenceLatency() {
  const { hasVectorSearch } = useCapabilities();
  const { currentConnection } = useConnection();

  const profileQuery = usePolling({
    fetcher: () => getInferenceLatencyProfile({ windowMs: DEFAULT_WINDOW_MS }),
    interval: PROFILE_POLL_MS,
    enabled: hasVectorSearch,
    refetchKey: currentConnection?.id,
  });

  const profile = profileQuery.data ?? null;
  const buckets = useMemo(() => (profile ? sortBuckets(profile.buckets) : []), [profile]);
  const hasFtSearchBuckets = buckets.some((b) => b.bucket.startsWith('FT.SEARCH:'));

  const content = (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Inference Latency</h1>
        <p className="text-muted-foreground">
          Per-bucket p50 / p95 / p99 across the inference hot path — FT.SEARCH indexes plus aggregate
          session reads and writes — over the last 15 minutes.
        </p>
      </div>

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
            No entries in the current window. Data appears after the first poll captures slow
            traffic; if your threshold directive is set high, you may need traffic exceeding it
            before any bucket appears.
          </CardContent>
        </Card>
      ) : (
        <>
          {hasFtSearchBuckets && (
            <div>
              <h2 className="text-xl font-semibold mb-3">Vector search</h2>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {buckets
                  .filter((b) => b.bucket.startsWith('FT.SEARCH:'))
                  .map((b) => (
                    <BucketTile key={b.bucket} bucket={b} />
                  ))}
              </div>
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
