import type { CveDatasetStatus, CveSeverityCounts } from '@betterdb/shared';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';

interface HeaderStripProps {
  product: string;
  version: string;
  severityCounts: CveSeverityCounts;
  dataset: CveDatasetStatus | undefined;
  refreshing: boolean;
  onRefresh: () => void;
}

function ageLabel(refreshedAt: number | null | undefined): string {
  if (!refreshedAt) {
    return 'advisories never refreshed';
  }

  const hours = Math.floor((Date.now() - refreshedAt) / 3_600_000);

  if (hours < 1) {
    return 'advisories refreshed less than an hour ago';
  }

  return `advisories refreshed ${hours}h ago`;
}

export function HeaderStrip({
  product,
  version,
  severityCounts,
  dataset,
  refreshing,
  onRefresh,
}: HeaderStripProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold">Security</h1>
        <p className="text-muted-foreground text-sm">
          {product} {version} · {ageLabel(dataset?.refreshedAt)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant="destructive">{severityCounts.critical} critical</Badge>
        <Badge variant="outline">{severityCounts.high} high</Badge>
        <Badge variant="outline">{severityCounts.medium} medium</Badge>
        <Badge variant="outline">{severityCounts.low} low</Badge>
        <Button variant="outline" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? 'Rescanning…' : 'Rescan'}
        </Button>
      </div>
    </div>
  );
}
