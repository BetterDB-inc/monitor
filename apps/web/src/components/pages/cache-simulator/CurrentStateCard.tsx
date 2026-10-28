import type { CacheSimulatorSnapshot } from '@betterdb/shared';
import { formatBytes } from '../../../lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';

function samplingCopy(sampled: number, target: number): string {
  if (sampled > target) {
    return `Sampling ${sampled.toLocaleString('en-US')} keys for a tighter range…`;
  }
  return `Sampling ${sampled.toLocaleString('en-US')} of ${target.toLocaleString('en-US')} keys…`;
}

function barPercent(sampled: number, target: number): number {
  return target > 0 ? Math.min(100, (sampled / target) * 100) : 100;
}

export function CurrentStateCard({ snapshot }: { snapshot: CacheSimulatorSnapshot }) {
  const { instant, estimate, progress, status, error } = snapshot;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Current state</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid gap-4 sm:grid-cols-4">
          <div>
            <dt className="text-sm text-muted-foreground">Used memory</dt>
            <dd className="text-xl font-semibold">{formatBytes(instant.usedMemory)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">maxmemory</dt>
            <dd className="text-xl font-semibold">{instant.maxmemory > 0 ? formatBytes(instant.maxmemory) : 'Not set'}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">Eviction policy</dt>
            <dd className="text-xl font-semibold">{instant.maxmemoryPolicy}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">Keys</dt>
            <dd className="text-xl font-semibold">{instant.totalKeys.toLocaleString('en-US')}</dd>
          </div>
        </dl>
        {status === 'sampling' && progress && (
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{samplingCopy(progress.sampled, progress.target)}</p>
            <div className="h-2 rounded bg-muted">
              <div className="h-2 rounded bg-primary" style={{ width: `${barPercent(progress.sampled, progress.target)}%` }} />
            </div>
          </div>
        )}
        {status === 'failed' && <p className="text-sm text-destructive">Sampling failed: {error}. The projection below uses INFO figures.</p>}
        {status === 'ready' && error && <p className="text-sm text-destructive">The last refresh failed: {error}. Showing the previous sample.</p>}
        {estimate && (
          <div className="space-y-2">
            <p className="text-sm">
              Sampled dataset size <span className="font-semibold">{formatBytes(estimate.totalBytes)}</span> ± {formatBytes(estimate.ci95Bytes)} (95%)
              {estimate.partial && ' — partial sample, the range is wider than usual'}
            </p>
            {estimate.likelyMissedLargeKeys && (
              <p className="text-sm text-amber-700 dark:text-amber-400">
                Some large keys were likely missed; the estimate may be low. The range reaches up to the dataset memory reported by INFO.
              </p>
            )}
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th>Type</th>
                  <th>Keys</th>
                  <th>Average size</th>
                  <th>Sampled</th>
                </tr>
              </thead>
              <tbody>
                {estimate.byType.map((entry) => (
                  <tr key={entry.type}>
                    <td>{entry.type}</td>
                    <td>{Math.round(entry.keys).toLocaleString('en-US')}</td>
                    <td>{formatBytes(Math.round(entry.avgBytes))}</td>
                    <td>{entry.sampled.toLocaleString('en-US')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
