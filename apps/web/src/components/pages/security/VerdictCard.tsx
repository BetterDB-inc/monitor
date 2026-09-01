import type { CveFinding, CveSeverityCounts } from '@betterdb/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';

interface VerdictCardProps {
  version: string;
  severityCounts: CveSeverityCounts;
  findings: CveFinding[];
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

export function VerdictCard({ version, severityCounts, findings }: VerdictCardProps) {
  const total =
    severityCounts.critical + severityCounts.high + severityCounts.medium + severityCounts.low;
  const upgrade = bestUpgrade(findings);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span data-testid="verdict-count">{total}</span> known{' '}
          {total === 1 ? 'CVE affects' : 'CVEs affect'} this instance
        </CardTitle>
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
