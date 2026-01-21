import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { CheckCircle, AlertTriangle, XCircle, GitBranch, Info } from 'lucide-react';
import { useReplicationLag } from '../../hooks/useReplicationLag';
import type { ReplicationLagInfo, NodeStats } from '../../types/cluster';
import type { ClusterNode } from '../../types/metrics';

interface ReplicationLagProps {
  nodes: ClusterNode[];
  nodeStats?: NodeStats[];
}

export function ReplicationLag({ nodes, nodeStats }: ReplicationLagProps) {
  const { lagData, hasLaggingReplicas, maxLagMs, maxOffsetDiff } = useReplicationLag(nodes, nodeStats);
  const hasDetailedStats = nodeStats && nodeStats.length > 0;

  if (lagData.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="text-center text-muted-foreground">
            No replication relationships found
          </div>
        </CardContent>
      </Card>
    );
  }

  const getStatusConfig = (status: ReplicationLagInfo['status']) => {
    switch (status) {
      case 'in-sync':
        return {
          icon: CheckCircle,
          color: 'text-green-500',
          bg: 'bg-green-500/10',
          label: 'In Sync',
        };
      case 'slight-lag':
        return {
          icon: AlertTriangle,
          color: 'text-blue-500',
          bg: 'bg-blue-500/10',
          label: 'Slight Lag',
        };
      case 'lagging':
        return {
          icon: AlertTriangle,
          color: 'text-yellow-500',
          bg: 'bg-yellow-500/10',
          label: 'Lagging',
        };
      case 'disconnected':
        return {
          icon: XCircle,
          color: 'text-red-500',
          bg: 'bg-red-500/10',
          label: 'Disconnected',
        };
    }
  };

  // Group by master
  const byMaster = lagData.reduce((acc, lag) => {
    if (!acc[lag.masterId]) {
      acc[lag.masterId] = [];
    }
    acc[lag.masterId].push(lag);
    return acc;
  }, {} as Record<string, ReplicationLagInfo[]>);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <GitBranch className="w-5 h-5" />
            Replication Status
          </CardTitle>
          {hasLaggingReplicas && (
            <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">
              Issues Detected
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Info banner for basic stats */}
        {!hasDetailedStats && (
          <div className="px-4 py-3 bg-blue-500/10 border border-blue-500/20 rounded-lg text-sm text-blue-700 dark:text-blue-400">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4 flex-shrink-0" />
              <div>
                <strong>Basic replication info shown.</strong> Detailed lag metrics are unavailable because individual node connections cannot be established. The topology and health status are still accurate.
              </div>
            </div>
          </div>
        )}

        {/* Summary Stats */}
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Total Replicas</div>
            <div className="text-2xl font-bold">{lagData.length}</div>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Max Lag (time)</div>
            <div className="text-2xl font-bold">
              {maxLagMs < 1000 ? `${maxLagMs}ms` : `${(maxLagMs / 1000).toFixed(1)}s`}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Max Offset Diff</div>
            <div className="text-2xl font-bold">{maxOffsetDiff.toLocaleString()}</div>
          </div>
        </div>

        {/* Replication Tree */}
        <div className="space-y-4">
          {Object.entries(byMaster).map(([masterId, replicas]) => {
            const masterAddress = replicas[0]?.masterAddress || masterId.substring(0, 8);

            return (
              <div key={masterId} className="space-y-2">
                {/* Master Node */}
                <div className="flex items-center gap-2 font-medium">
                  <GitBranch className="w-4 h-4 text-blue-500" />
                  <span className="text-sm">Master: {masterAddress}</span>
                  <Badge variant="outline" className="text-xs">primary</Badge>
                </div>

                {/* Replicas */}
                <div className="ml-6 space-y-2">
                  {replicas.map((replica) => {
                    const config = getStatusConfig(replica.status);
                    const StatusIcon = config.icon;

                    return (
                      <div
                        key={replica.replicaId}
                        className={`p-3 rounded-lg border ${
                          replica.status === 'lagging' || replica.status === 'disconnected'
                            ? 'border-yellow-500/30 bg-yellow-500/5'
                            : 'border-muted'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <StatusIcon className={`w-4 h-4 ${config.color}`} />
                            <span className="text-sm font-medium">{replica.replicaAddress}</span>
                            <Badge className={`${config.bg} ${config.color} border-0 text-xs`}>
                              {config.label}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            {replica.linkStatus === 'up' ? (
                              <>
                                <div>
                                  <span className="font-medium">Offset Diff:</span>{' '}
                                  <span className={replica.offsetDiff > 1000 ? 'text-yellow-500' : ''}>
                                    {replica.offsetDiff.toLocaleString()}
                                  </span>
                                </div>
                                <div>
                                  <span className="font-medium">Lag:</span>{' '}
                                  <span className={replica.lagMs > 100 ? 'text-yellow-500' : ''}>
                                    {replica.lagMs < 1000
                                      ? `${replica.lagMs}ms`
                                      : `${(replica.lagMs / 1000).toFixed(1)}s`}
                                  </span>
                                </div>
                              </>
                            ) : (
                              <div className="text-red-500 font-medium">
                                Link Down
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Warning Messages */}
                        {replica.status === 'lagging' && (
                          <div className="mt-2 text-xs text-yellow-600">
                            ⚠️ Replica is lagging behind master. Consider investigating replication performance.
                          </div>
                        )}
                        {replica.status === 'disconnected' && (
                          <div className="mt-2 text-xs text-red-600">
                            ⚠️ Replica link is down. Check network connectivity and replication configuration.
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="pt-4 border-t">
          <div className="text-xs text-muted-foreground space-y-1">
            <div><strong>In Sync:</strong> Offset difference is 0</div>
            <div><strong>Slight Lag:</strong> Offset difference &lt; 1000 and lag &lt; 100ms</div>
            <div><strong>Lagging:</strong> Significant offset difference or lag &gt; 100ms</div>
            <div><strong>Disconnected:</strong> Master link is down</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
