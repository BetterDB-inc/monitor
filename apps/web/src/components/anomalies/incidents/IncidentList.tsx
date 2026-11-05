import { Link } from 'react-router-dom';
import { Siren } from 'lucide-react';
import { EmptyState } from '../../ui/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table';
import type { IncidentTimeline } from '../../../types/anomaly';
import { formatDateTime, formatDuration, metricLabel, patternLabel } from '../anomaly-display';
import { IncidentStatusBadge } from './IncidentStatusBadge';
import { incidentDurationMs, incidentPath, isIncidentOpen } from './incident-summary';

interface IncidentListProps {
  incidents: IncidentTimeline[] | undefined;
  now: number;
}

function incidentTitle(incident: IncidentTimeline): string {
  if (incident.matchedPatterns.length > 0)
    return incident.matchedPatterns.map(patternLabel).join(', ');
  const first = incident.entries[0];
  return first ? metricLabel(first.metricType) : 'Incident';
}

function scopeLabel(incident: IncidentTimeline): string {
  const nodes = new Set(incident.entries.map((e) => e.nodeAddr).filter((n): n is string => !!n));
  const connections = incident.connectionIds.length;
  const parts = [`${connections} connection${connections === 1 ? '' : 's'}`];
  if (nodes.size > 0) parts.push(`${nodes.size} node${nodes.size === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export function IncidentList({ incidents, now }: IncidentListProps) {
  if (!incidents?.length) {
    return (
      <EmptyState
        variant="inline"
        icon={Siren}
        title="No incidents in this time range"
        description="Related anomalies are grouped into incidents as they are detected"
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Incident</TableHead>
          <TableHead>Scope</TableHead>
          <TableHead>Started</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {incidents.map((incident) => {
          const duration = formatDuration(incidentDurationMs(incident, now));
          return (
            <TableRow key={incident.incidentId}>
              <TableCell>
                <Link
                  to={incidentPath(incident.incidentId)}
                  className="font-medium hover:underline"
                >
                  {incidentTitle(incident)}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {incident.entries.length} event{incident.entries.length === 1 ? '' : 's'}
                </p>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {scopeLabel(incident)}
              </TableCell>
              <TableCell className="text-sm">{formatDateTime(incident.startedAt)}</TableCell>
              <TableCell className="text-sm">
                {isIncidentOpen(incident) ? `${duration} so far` : duration}
              </TableCell>
              <TableCell>
                <IncidentStatusBadge status={incident.recovery.status} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
