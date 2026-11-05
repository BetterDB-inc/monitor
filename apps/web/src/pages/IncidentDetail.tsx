import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, SearchX } from 'lucide-react';
import { metricsApi } from '../api/metrics';
import { ApiError } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { EmptyState } from '../components/ui/empty-state';
import { QueryErrorState } from '../components/QueryErrorState';
import { IncidentTimelineView } from '../components/anomalies/incidents/IncidentTimelineView';
import type { IncidentTimeline } from '../types/anomaly';

export function IncidentDetail() {
  const { incidentId = '' } = useParams<{ incidentId: string }>();
  const { currentConnection } = useConnection();
  const {
    data: incident,
    error,
    loading,
    lastUpdated,
  } = usePolling<IncidentTimeline>({
    fetcher: () => metricsApi.getIncident(incidentId),
    interval: 5000,
    refetchKey: `${currentConnection?.id ?? ''}:${incidentId}`,
  });
  const notFound = error instanceof ApiError && error.status === 404;

  return (
    <div className="space-y-6">
      <Link
        to="/anomalies?tab=incidents"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to incidents
      </Link>
      {notFound ? (
        <EmptyState
          icon={SearchX}
          title="Incident not found"
          description="It may be outside the stored history, or belong to another connection."
        />
      ) : incident ? (
        <IncidentTimelineView
          incident={incident}
          now={lastUpdated?.getTime() ?? incident.lastEventAt}
        />
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading incident…</p>
      ) : (
        <QueryErrorState
          error={error}
          fallback={<EmptyState title="Could not load the incident" description={error?.message} />}
        />
      )}
    </div>
  );
}
