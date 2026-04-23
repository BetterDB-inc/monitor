import type { InferenceLatencyBucket } from '@betterdb/shared';
import { formatDurationUs } from '@/lib/utils.ts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { InferenceSlaConfig } from '@/components/inference/InferenceSlaConfig.tsx';
import { Button } from '@/components/ui/button.tsx';

function bucketLabel(bucket: string): string {
  if (bucket.startsWith('FT.SEARCH:')) {
    return bucket;
  }
  if (bucket === 'read') {
    return 'Session reads (GET / MGET)';
  }
  if (bucket === 'write') {
    return 'Session writes (SET / HSET family)';
  }
  return bucket;
}

export function BucketTile({ bucket }: { bucket: InferenceLatencyBucket }) {
  const borderClass = bucket.unhealthy ? 'border-destructive/60 bg-destructive/5' : 'border-border';
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
          <div
            className="text-xs"
            style={{ color: 'var(--chart-warning)' }}
          >
            Latency degraded during indexing since{' '}
            {new Date(bucket.namedEvents[0].since).toLocaleTimeString()}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
