import type {
  KvCacheEngine,
  KvCacheFootprintSnapshot,
  KvCacheSampleBucket,
} from '@betterdb/shared';
import { Line, LineChart, ResponsiveContainer } from 'recharts';
import { formatBytes } from '../../../lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { evictionsPerMinute, formatPercent } from './kv-cache-format';

interface Props {
  latest: KvCacheFootprintSnapshot;
  history: KvCacheFootprintSnapshot[];
  engines: KvCacheEngine[];
  recentHitRate: number | null;
  buckets: KvCacheSampleBucket[];
}

interface StatCardProps {
  title: string;
  value: string;
  subtitle?: string;
  children?: React.ReactNode;
}

function StatCard({ title, value, subtitle, children }: StatCardProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <p className="text-2xl font-semibold">{value}</p>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        {children}
      </CardContent>
    </Card>
  );
}

function hitRateSparkline(buckets: KvCacheSampleBucket[]) {
  const byTimestamp = new Map<number, { hit: number; requested: number }>();
  for (const bucket of buckets) {
    const entry = byTimestamp.get(bucket.timestamp) ?? { hit: 0, requested: 0 };
    entry.hit += bucket.hitTokens;
    entry.requested += bucket.requestedTokens;
    byTimestamp.set(bucket.timestamp, entry);
  }
  return [...byTimestamp.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, { requested }]) => requested > 0)
    .map(([timestamp, { hit, requested }]) => ({ timestamp, hitRate: hit / requested }));
}

export function KvCacheCards({ latest, history, engines, recentHitRate, buckets }: Props) {
  const sparkline = hitRateSparkline(buckets);
  const evictions = evictionsPerMinute(history);
  const memoryShare = latest.maxmemory > 0 ? latest.bytesEst / latest.maxmemory : null;
  const footprintDetails = [
    `${formatPercent(latest.lmcacheMemoryShare)} of used memory`,
    memoryShare !== null ? `${formatPercent(memoryShare)} of maxmemory` : null,
  ].filter((part): part is string => part !== null);

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        title="Hit rate (15 min)"
        value={engines.length === 0 ? '—' : formatPercent(recentHitRate)}
        subtitle={engines.length === 0 ? 'Link an engine to see hit rate' : undefined}
      >
        {engines.length > 0 && sparkline.length > 1 && (
          <div className="h-10" data-testid="hit-rate-sparkline">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={sparkline}>
                <Line
                  type="monotone"
                  dataKey="hitRate"
                  stroke="#6366f1"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </StatCard>
      <StatCard
        title="Footprint"
        value={formatBytes(latest.bytesEst)}
        subtitle={`${latest.chunksEst.toLocaleString()} chunks · ${footprintDetails.join(' · ')}`}
      />
      <StatCard
        title="Evictions/min"
        value={evictions === null ? '—' : evictions.toLocaleString()}
      />
      <StatCard
        title="TTL coverage"
        value={formatPercent(1 - latest.noTtlRatio)}
        subtitle={latest.maxmemoryPolicy}
      />
    </div>
  );
}
