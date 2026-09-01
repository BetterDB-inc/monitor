import type { CveFinding, CveSeverityCounts } from '@betterdb/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';

interface VerdictCardProps {
  version: string;
  severityCounts: CveSeverityCounts;
  findings: CveFinding[];
  uncheckedCount: number;
  incomplete: boolean;
}

interface UpgradeTarget {
  version: string;
  clears: number;
}

function bestUpgrade(findings: CveFinding[]): UpgradeTarget | null {
  const tally = new Map<string, number>();

  for (const entry of findings) {
    if (!entry.fixedIn) {
      continue;
    }

    tally.set(entry.fixedIn, (tally.get(entry.fixedIn) ?? 0) + 1);
  }

  if (tally.size === 0) {
    return null;
  }

  const [version, clears] = [...tally.entries()].sort((a, b) => {
    return b[1] - a[1];
  })[0];

  return { version, clears };
}

export function VerdictCard({
  version,
  severityCounts,
  findings,
  uncheckedCount,
  incomplete,
}: VerdictCardProps) {
  const total =
    severityCounts.critical + severityCounts.high + severityCounts.medium + severityCounts.low;
  const upgrade = bestUpgrade(findings);
  const noun = total === 1 ? 'CVE' : 'CVEs';

  return (
    <Card>
      <CardHeader className="space-y-2">
        <CardTitle data-testid="verdict-headline">
          {incomplete ? (
            <span>
              <span data-testid="verdict-count">{total}</span> known {noun} matched — this scan is
              incomplete
            </span>
          ) : (
            <span>
              <span data-testid="verdict-count">{total}</span> known{' '}
              {total === 1 ? 'CVE affects' : 'CVEs affect'} this instance
            </span>
          )}
        </CardTitle>
        {uncheckedCount > 0 ? (
          <p data-testid="verdict-unchecked" className="text-foreground text-sm font-medium">
            <span data-testid="verdict-unchecked-count">{uncheckedCount}</span> further{' '}
            {uncheckedCount === 1 ? 'advisory' : 'advisories'} could not be checked against{' '}
            {version} — unknown, not safe.
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-sm">
          Matched against the reported engine version {version}.
        </p>
        {upgrade ? (
          <p data-testid="upgrade-banner" className="bg-muted rounded-md p-3 text-sm">
            Upgrading to {upgrade.version} clears {upgrade.clears} of them.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
