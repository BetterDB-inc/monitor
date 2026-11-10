import { useState } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { SearchX, Unplug } from 'lucide-react';
import { metricsApi } from '../api/metrics';
import { useConnection } from '../hooks/useConnection';
import { CONNECTION_PARAM } from '../lib/connectionParam';
import { ConnectionLink } from '../components/ConnectionLink';
import { QueryErrorState } from '../components/QueryErrorState';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { incidentPath } from '../components/anomalies/incidents/incident-summary';

function eventTime(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const at = Number(raw);
  return Number.isFinite(at) ? Math.trunc(at) : null;
}

export function IncidentByEvent() {
  const { anomalyId = '' } = useParams<{ anomalyId: string }>();
  const [searchParams] = useSearchParams();
  const { currentConnection, connections, loading } = useConnection();
  const connectionId = currentConnection?.id;
  const rawAt = searchParams.get('at');
  const at = eventTime(rawAt);
  const linkKey = `${anomalyId}\u0000${rawAt}`;
  const inUrl = searchParams.get(CONNECTION_PARAM);
  const [link, setLink] = useState({ key: linkKey, connection: inUrl });
  if (link.key !== linkKey) setLink({ key: linkKey, connection: inUrl });
  const linkedConnection = link.key === linkKey ? link.connection : inUrl;
  const connectionReady = inUrl === null || inUrl === connectionId;
  const connectionMissing =
    linkedConnection !== null && !loading && !connections.some((c) => c.id === linkedConnection);
  const lookup = useQuery({
    queryKey: ['incident-by-event', connectionId ?? '', anomalyId, at],
    queryFn: ({ signal }) => metricsApi.findIncidentByEvent(anomalyId, at ?? 0, signal),
    enabled: at !== null && connectionReady && !connectionMissing,
    retry: false,
    staleTime: 0,
  });
  const data = lookup.isFetchedAfterMount ? lookup.data : undefined;
  const error = lookup.isFetchedAfterMount ? lookup.error : null;
  const refetch = lookup.refetch;

  if (data?.incidentId) {
    const query = connectionId ? `${CONNECTION_PARAM}=${encodeURIComponent(connectionId)}` : '';
    return <Navigate replace to={incidentPath(data.incidentId, query)} />;
  }
  if (connectionMissing) {
    return (
      <EmptyState
        icon={Unplug}
        title="Connection not available"
        description="This link points to a connection that is not set up here, so its incident cannot be opened."
        action={
          <ConnectionLink to="/anomalies" className="text-sm underline">
            Back to anomalies
          </ConnectionLink>
        }
      />
    );
  }
  if (at === null || data) {
    return (
      <EmptyState
        icon={SearchX}
        title="No incident for this event"
        description="This event is not part of a stored incident. It may be older than the stored history, or belong to another connection."
        action={
          <ConnectionLink to="/anomalies" className="text-sm underline">
            Back to anomalies
          </ConnectionLink>
        }
      />
    );
  }
  if (error) {
    return (
      <QueryErrorState
        error={error}
        fallback={
          <EmptyState
            title="Could not find the incident"
            description={error.message}
            action={
              <Button variant="outline" size="sm" onClick={() => void refetch()}>
                Try again
              </Button>
            }
          />
        }
      />
    );
  }
  return (
    <p role="status" className="text-sm text-muted-foreground">
      Finding the incident…
    </p>
  );
}
