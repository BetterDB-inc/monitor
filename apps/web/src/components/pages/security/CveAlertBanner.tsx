import { ShieldAlert } from 'lucide-react';
import type { CveFinding, CveScanResult } from '@betterdb/shared';
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert';
import { Badge } from '../../ui/badge';

interface CveAlertBannerProps {
  result: CveScanResult;
}

function allFindings(result: CveScanResult): CveFinding[] {
  return result.nodes.flatMap((node) => node.findings);
}

/**
 * Action banner for CVE detection → action.
 * Shown when the current scan contains critical or KEV-exploited findings.
 * Counts and badges derive from the same findings list so they always agree.
 * Mirrors DataLossAlertBanner styling (destructive for critical).
 */
export function CveAlertBanner({ result }: CveAlertBannerProps) {
  const findings = allFindings(result);
  const critical = findings.filter((finding) => finding.advisory.severity === 'critical').length;
  const kev = findings.filter((finding) => finding.advisory.knownExploited === true).length;

  if (critical === 0 && kev === 0) {
    return null;
  }

  const isCritical = critical > 0;
  const title = isCritical ? 'Critical CVEs detected' : 'Exploited (KEV) CVEs detected';
  // Critical first, then KEV, then the rest — so the badge row always covers
  // what the count line advertises, in either mode.
  const topIds = [...findings]
    .sort((a, b) => {
      const rank = (finding: CveFinding) =>
        finding.advisory.severity === 'critical' ? 0 : finding.advisory.knownExploited === true ? 1 : 2;
      return rank(a) - rank(b);
    })
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
