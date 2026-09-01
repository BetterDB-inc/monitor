import type { Advisory, CveFinding } from '@betterdb/shared';
import { Badge } from '../../ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table';

interface FindingsTableProps {
  findings: CveFinding[];
  unversioned: Advisory[];
  showChips?: boolean;
}

function epssLabel(entry: Advisory): string {
  if (entry.epssPercentile === undefined) {
    return '—';
  }

  return `${(entry.epssPercentile * 100).toFixed(1)} pct`;
}

function exploitedCount(findings: CveFinding[]): number {
  return findings.filter((entry) => {
    return entry.advisory.knownExploited;
  }).length;
}

export function FindingsTable({ findings, unversioned, showChips = false }: FindingsTableProps) {
  return (
    <div className="space-y-3">
      {showChips ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge data-testid="filter-chip-all" variant="outline">
            All {findings.length + unversioned.length}
          </Badge>
          <Badge variant="outline">Exploited {exploitedCount(findings)}</Badge>
          <Badge variant="outline">Needs review {unversioned.length}</Badge>
        </div>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>CVE</TableHead>
            <TableHead>Severity</TableHead>
            <TableHead>EPSS</TableHead>
            <TableHead>Fixed in</TableHead>
            <TableHead>Confidence</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {findings.map((entry) => {
            return (
              <TableRow
                key={entry.advisory.cveId}
                data-testid={`finding-row-${entry.advisory.cveId}`}
              >
                <TableCell>{entry.advisory.cveId}</TableCell>
                <TableCell className="space-x-2">
                  <Badge
                    variant={entry.advisory.severity === 'critical' ? 'destructive' : 'outline'}
                  >
                    {entry.advisory.severity}
                  </Badge>
                  {entry.advisory.knownExploited ? <Badge variant="destructive">KEV</Badge> : null}
                </TableCell>
                <TableCell>{epssLabel(entry.advisory)}</TableCell>
                <TableCell>{entry.fixedIn ?? '—'}</TableCell>
                <TableCell>{entry.advisory.confidence}</TableCell>
              </TableRow>
            );
          })}
          {unversioned.map((entry) => {
            return (
              <TableRow key={entry.cveId} data-testid={`finding-row-${entry.cveId}`}>
                <TableCell>{entry.cveId}</TableCell>
                <TableCell>
                  <Badge variant="outline">UNKNOWN</Badge>
                </TableCell>
                <TableCell>—</TableCell>
                <TableCell>—</TableCell>
                <TableCell>review</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
