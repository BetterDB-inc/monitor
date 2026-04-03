import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { CheckCircle, AlertCircle, XCircle } from 'lucide-react';
import type { ClusterHealth } from '../../types/cluster';

interface ClusterHealthCardProps {
  health: ClusterHealth;
  masterCount: number;
  replicaCount: number;
}

export function ClusterHealthCard({ health, masterCount, replicaCount }: ClusterHealthCardProps) {
  const statusConfig = {
    healthy: {
      icon: CheckCircle,
      color: 'text-green-500',
      bg: 'bg-green-500/10',
      border: 'border-green-500',
      label: 'OK',
    },
    degraded: {
      icon: AlertCircle,
      color: 'text-yellow-500',
      bg: 'bg-yellow-500/10',
      border: 'border-yellow-500',
      label: 'Degraded',
    },
    failing: {
      icon: XCircle,
      color: 'text-destructive',
      bg: 'bg-destructive/10',
      border: 'border-destructive',
      label: 'Failing',
    },
  };

  const config = statusConfig[health.status];
  const StatusIcon = config.icon;
  const slotsPercentage = health.totalSlots > 0
    ? (health.slotsAssigned / health.totalSlots) * 100
    : 0;

  return (
    <Card className={`${health.status !== 'healthy' ? config.border : ''}`}>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <StatusIcon className={`w-5 h-5 ${config.color}`} />
          Cluster Health
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status Badge */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">State:</span>
          <Badge className={`${config.bg} ${config.color} border-0`}>
            {config.label}
          </Badge>
        </div>

        {/* Slots Coverage */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Slot Coverage</span>
            <span className="font-medium">
              {health.slotsAssigned.toLocaleString()} / {health.totalSlots.toLocaleString()}
            </span>
          </div>
          <div className="w-full bg-muted rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all ${
                slotsPercentage === 100 ? 'bg-green-500' : 'bg-yellow-500'
              }`}
              style={{ width: `${slotsPercentage}%` }}
            />
          </div>
          <div className="text-xs text-muted-foreground">
            {slotsPercentage.toFixed(1)}% covered
          </div>
        </div>

        {/* Node Counts */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Masters</div>
            <div className="text-2xl font-bold">{masterCount}</div>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Replicas</div>
            <div className="text-2xl font-bold">{replicaCount}</div>
          </div>
        </div>

        {/* Slot Health Details */}
        {(health.slotsFail > 0 || health.slotsPfail > 0) && (
          <div className="pt-3 border-t space-y-2">
            {health.slotsFail > 0 && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-destructive">Failed Slots</span>
                <span className="font-medium text-destructive">{health.slotsFail}</span>
              </div>
            )}
            {health.slotsPfail > 0 && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-yellow-500">Possibly Failing</span>
                <span className="font-medium text-yellow-500">{health.slotsPfail}</span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
