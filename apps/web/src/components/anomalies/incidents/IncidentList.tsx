import { ConnectionLink } from '../../ConnectionLink';
import { Siren } from 'lucide-react';
import { EmptyState } from '../../ui/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table';
import type { IncidentTimeline } from '../../../types/anomaly';
import { formatDateTime } from '../../../lib/formatters';
import { IncidentStatusBadge } from './IncidentStatusBadge';
import { LiveClock, LiveDuration } from './LiveDuration';
import { incidentPath, incidentTitle, isIncidentOpen } from './incident-summary';

interface IncidentListProps {
  incidents: IncidentTimeline[] | undefined;
  now?: number;
  loading?: boolean;
  refreshing?: boolean;
  limit?: number;
  linkQuery?: string;
}

function scopeLabel(incident: IncidentTimeline): string {
  const nodes = new Set(incident.entries.map((e) => e.nodeAddr).filter((n): n is string => !!n));
  const connections = incident.connectionIds.length;
  const parts = connections > 0 ? [`${connections} connection${connections === 1 ? '' : 's'}`] : [];
  if (nodes.size > 0) parts.push(`${nodes.size} node${nodes.size === 1 ? '' : 's'}`);
  return parts.join(' · ') || 'Unscoped';
}

export function IncidentList({
  incidents,
  now,
  loading,
  refreshing = false,
  limit,
  linkQuery,
}: IncidentListProps) {
  if (!incidents?.length && (loading || refreshing)) {
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
      {refreshing && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading incidents…
        </p>
      )}
      {limit !== undefined && incidents.length > limit && (
        <p className="text-sm text-muted-foreground">
          Showing the newest {limit} incidents. Narrow the time range to see older ones.
        </p>
      )}
      <LiveClock enabled={now === undefined && incidents.some(isIncidentOpen)}>
        <div
          data-testid="incident-rows"
          aria-busy={refreshing}
          className={refreshing ? 'opacity-60' : undefined}
        >
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
              {incidents.slice(0, limit).map((incident) => (
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
                    <LiveDuration incident={incident} now={now} />
                  </TableCell>
                  <TableCell>
                    <IncidentStatusBadge status={incident.recovery.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </LiveClock>
    </div>
  );
}
