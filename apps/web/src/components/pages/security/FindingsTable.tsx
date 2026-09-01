import type { Advisory, CveFinding } from '@betterdb/shared';
import { Badge } from '../../ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table';
import { AdvisoryCell } from './AdvisoryCell';
import { affectedRangesLabel } from './affected-range';

interface FindingsTableProps {
  findings: CveFinding[];
  unversioned: Advisory[];
  showChips?: boolean;
}

const COLUMN_COUNT = 6;

function epssLabel(entry: Advisory): string {
  if (entry.epssPercentile === undefined) {
    return '-';
  }

  return `${(entry.epssPercentile * 100).toFixed(1)} pct`;
}

function exploitedCount(findings: CveFinding[]): number {
  return findings.filter((entry) => {
    return entry.advisory.knownExploited;
  }).length;
}

function scopeLabel(entry: CveFinding): string {
  if (entry.matchedOn === 'module') {
    return `module ${entry.moduleName ?? 'unknown'}`;
  }

  return 'engine';
}

function onlyUnmatched(findings: CveFinding[], unversioned: Advisory[]): Advisory[] {
  const matched = new Set(
    findings.map((entry) => {
      return entry.advisory.cveId;
    }),
  );

  return unversioned.filter((entry) => {
    return matched.has(entry.cveId) === false;
  });
}

export function FindingsTable({ findings, unversioned, showChips = false }: FindingsTableProps) {
  const unmatched = onlyUnmatched(findings, unversioned);
  const empty = findings.length === 0 && unmatched.length === 0;

  return (
    <div className="space-y-3">
      {showChips ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge data-testid="filter-chip-all" variant="outline">
            All {findings.length + unmatched.length}
          </Badge>
          <Badge variant="outline">Exploited {exploitedCount(findings)}</Badge>
          <Badge variant="outline">Needs review {unmatched.length}</Badge>
        </div>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>CVE</TableHead>
            <TableHead>Affects</TableHead>
            <TableHead>Severity</TableHead>
            <TableHead>EPSS</TableHead>
            <TableHead>Fixed in</TableHead>
            <TableHead>Confidence</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {empty ? (
            <TableRow>
              <TableCell
                data-testid="findings-empty"
                colSpan={COLUMN_COUNT}
                className="text-muted-foreground text-sm"
              >
                Nothing here - no advisory matched this group.
              </TableCell>
            </TableRow>
          ) : null}
          {findings.map((entry) => {
            const range = affectedRangesLabel(entry.advisory.affected);

            return (
              <TableRow
                key={`matched-${entry.advisory.cveId}`}
                data-testid={`finding-row-${entry.advisory.cveId}`}
              >
                <TableCell>
                  <AdvisoryCell entry={entry.advisory} />
                </TableCell>
                <TableCell data-testid={`finding-scope-${entry.advisory.cveId}`}>
                  <span className="block">{scopeLabel(entry)}</span>
                  {range === null ? null : (
                    <span
                      data-testid={`finding-range-${entry.advisory.cveId}`}
                      className="text-muted-foreground block text-xs"
                    >
                      {range}
                    </span>
                  )}
                </TableCell>
                <TableCell className="space-y-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={entry.advisory.severity === 'critical' ? 'destructive' : 'outline'}
                    >
                      {entry.advisory.severity}
                    </Badge>
                    {entry.advisory.knownExploited ? (
                      <Badge variant="destructive">KEV</Badge>
                    ) : null}
                  </span>
                  {entry.advisory.cvssScore === undefined ? null : (
                    <span className="text-muted-foreground block text-xs">
                      CVSS {entry.advisory.cvssScore.toFixed(1)}
                    </span>
                  )}
                </TableCell>
                <TableCell>{epssLabel(entry.advisory)}</TableCell>
                <TableCell>{entry.fixedIn ?? '-'}</TableCell>
                <TableCell>{entry.advisory.confidence}</TableCell>
              </TableRow>
            );
          })}
          {unmatched.map((entry) => {
            return (
              <TableRow
                key={`unversioned-${entry.cveId}`}
                data-testid={`finding-row-${entry.cveId}`}
              >
                <TableCell>
                  <AdvisoryCell entry={entry} />
                </TableCell>
                <TableCell data-testid={`finding-scope-${entry.cveId}`}>not determined</TableCell>
                <TableCell>
                  <Badge variant="outline">UNKNOWN</Badge>
                </TableCell>
                <TableCell>-</TableCell>
                <TableCell>-</TableCell>
                <TableCell>review</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
