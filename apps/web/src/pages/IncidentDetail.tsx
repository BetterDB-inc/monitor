import { useParams, useSearchParams } from 'react-router-dom';
import { ConnectionLink } from '../components/ConnectionLink';
import { ArrowLeft, SearchX } from 'lucide-react';
import { metricsApi } from '../api/metrics';
import { ApiError } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { QueryErrorState } from '../components/QueryErrorState';
import { IncidentNotice } from '../components/anomalies/incidents/IncidentNotice';
import { IncidentTimelineView } from '../components/anomalies/incidents/IncidentTimelineView';
import { dateRangeQuery } from '../components/anomalies/incidents/incident-summary';
import type { IncidentRecoveryStatus, IncidentTimeline } from '../types/anomaly';

const INCIDENT_POLL_MS = 15_000;
const TERMINAL_STATUSES: ReadonlySet<IncidentRecoveryStatus> = new Set(['recovered', 'unknown']);

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function IncidentDetail() {
  const { incidentId = '' } = useParams<{ incidentId: string }>();
  const [searchParams] = useSearchParams();
  const { currentConnection } = useConnection();
  const {
    data: incident,
    error,
    loading,
    lastUpdated,
    refresh,
  } = usePolling<IncidentTimeline>({
    fetcher: (signal) => metricsApi.getIncident(incidentId, signal),
    interval: (latest, latestError) =>
      latestError || (latest && TERMINAL_STATUSES.has(latest.recovery.status))
        ? false
        : INCIDENT_POLL_MS,
    shouldRetry: (retryError) => !isNotFound(retryError),
    refetchKey: `${currentConnection?.id ?? ''}:${incidentId}`,
  });
  const notFound = isNotFound(error);
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
          {error && (
            <IncidentNotice>
              <div className="flex flex-wrap items-center gap-3">
                <p>
                  {notFound
                    ? 'This incident can no longer be found. Its events may have been regrouped into another incident.'
                    : `Could not refresh the incident: ${error.message}.`}{' '}
                  Showing the last timeline loaded.
                </p>
                <Button variant="outline" size="sm" onClick={() => void refresh()}>
                  Try again
                </Button>
              </div>
            </IncidentNotice>
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
          fallback={
            <EmptyState
              title="Could not load the incident"
              description={error?.message}
              action={
                <Button variant="outline" size="sm" onClick={() => void refresh()}>
                  Try again
                </Button>
              }
            />
          }
        />
      )}
    </div>
  );
}
