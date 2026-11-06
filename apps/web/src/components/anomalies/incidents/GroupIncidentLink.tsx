import { useQuery } from '@tanstack/react-query';
import { metricsApi } from '../../../api/metrics';
import { ConnectionLink } from '../../ConnectionLink';
import { incidentPath } from './incident-summary';

const MAX_LOOKUP_IDS = 500;

interface GroupIncidentLinkProps {
  connectionId: string | undefined;
  anomalies: { id: string; timestamp: number }[];
  linkQuery: string;
}

export function GroupIncidentLink({ connectionId, anomalies, linkQuery }: GroupIncidentLinkProps) {
  const sample = anomalies.slice(0, MAX_LOOKUP_IDS);
  const ids = sample.map((a) => a.id);
  const times = sample.map((a) => a.timestamp);
  const { data } = useQuery({
    queryKey: ['incident-lookup', connectionId, ids],
    queryFn: ({ signal }) =>
      metricsApi.lookupIncident(
        { anomalyIds: ids, startTime: Math.min(...times), endTime: Math.max(...times) },
        signal,
      ),
    enabled: ids.length > 0,
    retry: false,
    staleTime: Infinity,
  });

  if (!data) return null;
  return (
    <ConnectionLink
      to={incidentPath(data.incidentId, linkQuery)}
      className="inline-flex text-sm font-medium text-primary hover:underline"
    >
      View incident timeline
    </ConnectionLink>
  );
}
