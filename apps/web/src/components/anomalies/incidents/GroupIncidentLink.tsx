import { ConnectionLink } from '../../ConnectionLink';
import { incidentPath } from './incident-summary';

interface GroupIncidentLinkProps {
  incidentId: string | undefined;
  linkQuery: string;
}

export function GroupIncidentLink({ incidentId, linkQuery }: GroupIncidentLinkProps) {
  if (!incidentId) return null;
  return (
    <ConnectionLink
      to={incidentPath(incidentId, linkQuery)}
      className="inline-flex text-sm font-medium text-primary hover:underline"
    >
      View incident timeline
    </ConnectionLink>
  );
}
