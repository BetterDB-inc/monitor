import { useParams, useSearchParams } from 'react-router-dom';
import { ConnectionLink } from '../components/ConnectionLink';
import { AlertTriangle, ArrowLeft, SearchX } from 'lucide-react';
import { metricsApi } from '../api/metrics';
import { ApiError } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { EmptyState } from '../components/ui/empty-state';
import { QueryErrorState } from '../components/QueryErrorState';
import { IncidentTimelineView } from '../components/anomalies/incidents/IncidentTimelineView';
import { dateRangeQuery } from '../components/anomalies/incidents/incident-summary';
import type { IncidentTimeline } from '../types/anomaly';

const OPEN_INCIDENT_POLL_MS = 15_000;
const RECOVERED_INCIDENT_POLL_MS = 60_000;

export function IncidentDetail() {
  const { incidentId = '' } = useParams<{ incidentId: string }>();
  const [searchParams] = useSearchParams();
  const { currentConnection } = useConnection();
  const {
    data: incident,
    error,
    loading,
    lastUpdated,
  } = usePolling<IncidentTimeline>({
    fetcher: (signal) => metricsApi.getIncident(incidentId, signal),
    interval: (latest) =>
      latest?.recovery.status === 'recovered' ? RECOVERED_INCIDENT_POLL_MS : OPEN_INCIDENT_POLL_MS,
    refetchKey: `${currentConnection?.id ?? ''}:${incidentId}`,
  });
  const notFound = error instanceof ApiError && error.status === 404;
  const range = dateRangeQuery(searchParams.get('start'), searchParams.get('end'));
  const backTo = `/anomalies?tab=incidents${range ? `&${range}` : ''}`;

  return (
    <div className="space-y-6">
      <ConnectionLink
        to={backTo}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to incidents
      </ConnectionLink>
      {incident ? (
        <>
          {error && !notFound && (
            <div
              role="status"
              className="flex gap-3 rounded-lg border border-yellow-500 bg-yellow-500/10 p-4 text-sm"
            >
              <AlertTriangle className="w-5 h-5 shrink-0 text-yellow-500" aria-hidden />
              <p>
                Could not refresh the incident: {error.message}. Showing the last timeline loaded.
              </p>
            </div>
          )}
          {notFound && (
            <div
              role="status"
              className="flex gap-3 rounded-lg border border-yellow-500 bg-yellow-500/10 p-4 text-sm"
            >
              <AlertTriangle className="w-5 h-5 shrink-0 text-yellow-500" aria-hidden />
              <p>
                This incident can no longer be found. Its events may have been regrouped into
                another incident. Showing the last timeline loaded.
              </p>
            </div>
          )}
          <IncidentTimelineView
            incident={incident}
            now={lastUpdated?.getTime() ?? incident.lastEventAt}
          />
        </>
      ) : notFound ? (
        <EmptyState
          icon={SearchX}
          title="Incident not found"
          description="It may be outside the stored history, or belong to another connection."
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
