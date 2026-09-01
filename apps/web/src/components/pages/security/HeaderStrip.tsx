import type { CveSeverityCounts } from '@betterdb/shared';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';

interface HeaderStripProps {
  subtitle: string;
  severityCounts: CveSeverityCounts | null;
  scopeLabel: string | null;
  refreshing: boolean;
  refreshError: string | null;
  onRefresh: () => void;
}

export function HeaderStrip({
  subtitle,
  severityCounts,
  scopeLabel,
  refreshing,
  refreshError,
  onRefresh,
}: HeaderStripProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold">Security</h1>
        <p data-testid="header-subtitle" className="text-muted-foreground text-sm">
          {subtitle}
        </p>
      </div>
      <div className="flex flex-col items-end gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {scopeLabel ? (
            <span data-testid="severity-scope" className="text-muted-foreground text-xs">
              {scopeLabel}
            </span>
          ) : null}
          {severityCounts ? (
            <>
              <Badge
                data-testid="severity-badge-critical"
                variant={severityCounts.critical > 0 ? 'destructive' : 'outline'}
              >
                {severityCounts.critical} critical
              </Badge>
              <Badge
                data-testid="severity-badge-high"
                variant="outline"
                className={severityCounts.high > 0 ? 'border-chart-warning' : undefined}
              >
                {severityCounts.high} high
              </Badge>
              <Badge data-testid="severity-badge-medium" variant="outline">
                {severityCounts.medium} medium
              </Badge>
              <Badge data-testid="severity-badge-low" variant="outline">
                {severityCounts.low} low
              </Badge>
            </>
          ) : null}
          <Button variant="outline" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? 'Rescanning…' : 'Rescan'}
          </Button>
        </div>
        {refreshError ? (
          <p data-testid="rescan-error" className="text-destructive max-w-sm text-right text-xs">
            Rescan failed: {refreshError}. What you see is the previous result, not a fresh one.
          </p>
        ) : null}
      </div>
    </div>
  );
}
