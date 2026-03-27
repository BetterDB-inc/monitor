import type { BaselineComparison, BaselineMetricStatus } from '@betterdb/shared';

interface Props {
  baseline?: BaselineComparison;
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatMetricValue(name: string, value: number | null): string {
  if (value === null) return '—';
  if (name === 'usedMemory') {
    if (value >= 1073741824) return `${(value / 1073741824).toFixed(2)} GB`;
    if (value >= 1048576) return `${(value / 1048576).toFixed(2)} MB`;
    return `${(value / 1024).toFixed(2)} KB`;
  }
  if (name === 'memFragmentationRatio') return value.toFixed(2);
  if (name === 'opsPerSec') return value.toLocaleString();
  return value.toFixed(2);
}

function MetricLabel({ name }: { name: string }) {
  const labels: Record<string, string> = {
    opsPerSec: 'Ops/sec',
    usedMemory: 'Used Memory',
    memFragmentationRatio: 'Mem Fragmentation',
    cpuSys: 'CPU Sys',
  };
  return <>{labels[name] ?? name}</>;
}

function StatusBadge({ status }: { status: BaselineMetricStatus }) {
  switch (status) {
    case 'normal':
      return <span className="px-1.5 py-0.5 rounded text-xs bg-green-100 text-green-800">normal</span>;
    case 'elevated':
      return <span className="px-1.5 py-0.5 rounded text-xs bg-amber-100 text-amber-800">elevated</span>;
    case 'degraded':
      return <span className="px-1.5 py-0.5 rounded text-xs bg-amber-100 text-amber-800">degraded</span>;
    case 'unavailable':
      return <span className="px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-500">unavailable</span>;
  }
}

export function BaselineSection({ baseline }: Props) {
  if (!baseline) {
    return <p className="text-sm text-muted-foreground">Not available.</p>;
  }

  if (!baseline.available) {
    return (
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Baseline Comparison</h3>
        <div className="bg-amber-50 border border-amber-200 text-amber-700 rounded-lg p-3 text-sm">
          {baseline.unavailableReason}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">Baseline Comparison</h3>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="pb-1 font-medium">Metric</th>
              <th className="pb-1 font-medium">Source Baseline</th>
              <th className="pb-1 font-medium">Target Current</th>
              <th className="pb-1 font-medium">Delta</th>
              <th className="pb-1 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {baseline.metrics.map((metric) => (
              <tr key={metric.name} className="border-b last:border-0">
                <td className="py-1"><MetricLabel name={metric.name} /></td>
                <td className="py-1 font-mono">{formatMetricValue(metric.name, metric.sourceBaseline)}</td>
                <td className="py-1 font-mono">{formatMetricValue(metric.name, metric.targetCurrent)}</td>
                <td className="py-1 font-mono">
                  {metric.percentDelta !== null
                    ? `${metric.percentDelta >= 0 ? '+' : ''}${metric.percentDelta.toFixed(1)}%`
                    : '—'}
                </td>
                <td className="py-1"><StatusBadge status={metric.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Baseline computed from {baseline.snapshotCount} snapshots over {formatDuration(baseline.baselineWindowMs)} before migration.
      </p>

      {/* Risk #5: Single snapshot caveat */}
      <p className="text-xs text-muted-foreground">
        Target metrics reflect a single sample taken at validation time. For ongoing monitoring, view the target connection's dashboard.
      </p>
    </div>
  );
}
