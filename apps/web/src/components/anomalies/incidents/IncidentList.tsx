import { ConnectionLink } from '../../ConnectionLink';
import { Siren } from 'lucide-react';
import { EmptyState } from '../../ui/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table';
import type { IncidentTimeline } from '../../../types/anomaly';
import { formatDateTime, formatDuration } from '../anomaly-display';
import { IncidentStatusBadge } from './IncidentStatusBadge';
import {
  incidentDurationMs,
  incidentPath,
  incidentTitle,
  isDurationOngoing,
} from './incident-summary';

interface IncidentListProps {
  incidents: IncidentTimeline[] | undefined;
  now: number;
  loading?: boolean;
  limit?: number;
  linkQuery?: string;
}

function scopeLabel(incident: IncidentTimeline): string {
  const nodes = new Set(incident.entries.map((e) => e.nodeAddr).filter((n): n is string => !!n));
  const connections = incident.connectionIds.length;
  const parts = [`${connections} connection${connections === 1 ? '' : 's'}`];
  if (nodes.size > 0) parts.push(`${nodes.size} node${nodes.size === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export function IncidentList({ incidents, now, loading, limit, linkQuery }: IncidentListProps) {
  if (!incidents && loading) {
    return <p className="text-sm text-muted-foreground">Loading incidents…</p>;
  }
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
    <div className="space-y-3">
      {limit !== undefined && incidents.length >= limit && (
        <p className="text-sm text-muted-foreground">
          Showing the newest {limit} incidents. Narrow the time range to see older ones.
        </p>
      )}
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
                  <ConnectionLink
                    to={incidentPath(incident.incidentId, linkQuery)}
                    className="font-medium hover:underline"
                  >
                    {incidentTitle(incident)}
                  </ConnectionLink>
                  <p className="text-xs text-muted-foreground">
                    {incident.entries.length} event{incident.entries.length === 1 ? '' : 's'}
                  </p>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {scopeLabel(incident)}
                </TableCell>
                <TableCell className="text-sm">{formatDateTime(incident.startedAt)}</TableCell>
                <TableCell className="text-sm">
                  {isDurationOngoing(incident) ? `${duration} so far` : duration}
                </TableCell>
                <TableCell>
                  <IncidentStatusBadge status={incident.recovery.status} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
