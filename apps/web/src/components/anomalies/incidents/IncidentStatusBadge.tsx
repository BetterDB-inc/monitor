import { Badge, type BadgeProps } from '../../ui/badge';
import type { IncidentRecoveryStatus } from '../../../types/anomaly';

const STATUS_CONFIG: Record<
  IncidentRecoveryStatus,
  { label: string; variant: BadgeProps['variant'] }
> = {
  active: { label: 'Active', variant: 'destructive' },
  recovering: { label: 'Recovering', variant: 'secondary' },
  recovered: { label: 'Recovered', variant: 'success' },
  degraded: { label: 'Degraded', variant: 'warning' },
  unknown: { label: 'Unknown', variant: 'outline' },
};

export function IncidentStatusBadge({ status }: { status: IncidentRecoveryStatus }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.unknown;
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
