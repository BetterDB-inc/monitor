import { ShieldAlert } from 'lucide-react';
import type { CveScanResult } from '@betterdb/shared';
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert';
import { Badge } from '../../ui/badge';

interface CveAlertBannerProps {
  result: CveScanResult;
}

function countKev(result: CveScanResult): number {
  let kev = 0;
  for (const node of result.nodes) {
    for (const finding of node.findings) {
      if (finding.advisory.knownExploited === true) {
        kev += 1;
      }
    }
  }
  return kev;
}

function countCritical(result: CveScanResult): number {
  return result.nodes.reduce((total, node) => total + node.severityCounts.critical, 0);
}

/**
 * Action banner for CVE detection → action.
 * Shown when the current scan contains critical or KEV-exploited findings.
 * Mirrors DataLossAlertBanner styling (destructive for critical).
 */
export function CveAlertBanner({ result }: CveAlertBannerProps) {
  const critical = countCritical(result);
  const kev = countKev(result);

  if (critical === 0 && kev === 0) {
    return null;
  }

  const isCritical = critical > 0;
  const title = isCritical ? 'Critical CVEs detected' : 'Exploited (KEV) CVEs detected';
  const topIds = result.nodes
    .flatMap((node) => node.findings)
    .filter((finding) => (isCritical ? finding.advisory.severity === 'critical' : finding.advisory.knownExploited))
    .slice(0, 3)
    .map((finding) => finding.advisory.cveId);

  return (
    <Alert
      data-testid="cve-alert-banner"
      variant={isCritical ? 'destructive' : 'default'}
      className={isCritical ? 'border-destructive' : 'border-chart-warning'}
    >
      <ShieldAlert className="h-4 w-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p className="font-medium">
          {critical > 0 ? `${critical} critical` : null}
          {critical > 0 && kev > 0 ? ' · ' : null}
          {kev > 0 ? `${kev} exploited (KEV)` : null} in this scan
          {result.drift ? ' · mixed versions across nodes' : null}
          {result.partial ? ' · incomplete scan (counts are a floor)' : null}.
        </p>
        {topIds.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {topIds.map((id) => (
              <Badge key={id} data-testid={`cve-alert-${id}`} variant="outline">
                {id}
              </Badge>
            ))}
            {kev > 0 ? (
              <Badge data-testid="cve-alert-kev" variant="destructive">
                KEV
              </Badge>
            ) : null}
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
