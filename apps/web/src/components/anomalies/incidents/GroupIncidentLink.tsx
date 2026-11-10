import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { incidentEventPath } from '@betterdb/shared';

export interface IncidentGroupMember {
  id: string;
  timestamp: number;
  connectionId?: string;
}

export function GroupIncidentLink({ group }: { group: { anomalies: IncidentGroupMember[] } }) {
  const [earliest] = [...group.anomalies].sort((a, b) => a.timestamp - b.timestamp);
  if (!earliest) return null;
  return (
    <Link
      to={incidentEventPath(earliest.id, earliest.timestamp, earliest.connectionId)}
      className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
    >
      View incident
      <ArrowRight className="w-4 h-4" aria-hidden />
    </Link>
  );
}
