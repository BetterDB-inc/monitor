import { useMemo } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { AlertTriangle, Activity, Database, Users } from 'lucide-react';
import { formatBytes } from '../../lib/utils';
import type { NodeStats } from '../../types/cluster';

interface NodeStatsComparisonProps {
  nodeStats?: NodeStats[];
}

export function NodeStatsComparison({ nodeStats }: NodeStatsComparisonProps) {
  const statsArray = nodeStats || [];

  const { means, imbalancedNodes } = useMemo(() => {
    if (statsArray.length === 0) {
      return {
        means: { memory: 0, ops: 0, clients: 0 },
        imbalancedNodes: [],
      };
    }

    const means = {
      memory: statsArray.reduce((sum, n) => sum + n.memoryUsed, 0) / statsArray.length,
      ops: statsArray.reduce((sum, n) => sum + n.opsPerSec, 0) / statsArray.length,
      clients: statsArray.reduce((sum, n) => sum + n.connectedClients, 0) / statsArray.length,
    };

    const imbalancedNodes = statsArray.filter((node) => {
      const memoryDeviation = Math.abs(node.memoryUsed - means.memory) / (means.memory || 1);
      const opsDeviation = Math.abs(node.opsPerSec - means.ops) / (means.ops || 1);
      const clientsDeviation = Math.abs(node.connectedClients - means.clients) / (means.clients || 1);

      return memoryDeviation > 0.2 || opsDeviation > 0.2 || clientsDeviation > 0.2;
    });

    return { means, imbalancedNodes };
  }, [statsArray]);

  if (statsArray.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="text-center text-muted-foreground">No node statistics available</div>
        </CardContent>
      </Card>
    );
  }

  const isImbalanced = (nodeId: string) =>
    imbalancedNodes.some((n) => n.nodeId === nodeId);

  const getDeviationColor = (value: number, mean: number) => {
    const deviation = Math.abs(value - mean) / (mean || 1);
    if (deviation > 0.2) return 'text-yellow-500';
    return 'text-muted-foreground';
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="w-5 h-5" />
          Node Performance Comparison
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Memory Usage */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium">Memory Usage</span>
            </div>
            <span className="text-xs text-muted-foreground">
              Avg: {formatBytes(means.memory)}
            </span>
          </div>
          <div className="space-y-2">
            {statsArray.map((node) => {
              const percentage = (node.memoryUsed / node.memoryPeak) * 100;
              const imbalanced = isImbalanced(node.nodeId);

              return (
                <div key={node.nodeId} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <span className={getDeviationColor(node.memoryUsed, means.memory)}>
                        {node.nodeAddress}
                      </span>
                      <Badge variant="outline" className="text-xs">
                        {node.role}
                      </Badge>
                      {imbalanced && (
                        <AlertTriangle className="w-3 h-3 text-yellow-500" />
                      )}
                    </div>
                    <span className="font-medium">
                      {formatBytes(node.memoryUsed)} / {formatBytes(node.memoryPeak)}
                    </span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-2">
                    <div
                      className={`h-2 rounded-full transition-all ${
                        imbalanced ? 'bg-yellow-500' : 'bg-blue-500'
                      }`}
                      style={{ width: `${Math.min(percentage, 100)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Operations per Second */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium">Operations/sec</span>
            </div>
            <span className="text-xs text-muted-foreground">
              Avg: {means.ops.toFixed(0)}
            </span>
          </div>
          <div className="space-y-2">
            {statsArray.map((node) => {
              const maxOps = Math.max(...statsArray.map((n) => n.opsPerSec));
              const percentage = maxOps > 0 ? (node.opsPerSec / maxOps) * 100 : 0;
              const imbalanced = isImbalanced(node.nodeId);

              return (
                <div key={node.nodeId} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className={getDeviationColor(node.opsPerSec, means.ops)}>
                      {node.nodeAddress}
                    </span>
                    <span className="font-medium">
                      {node.opsPerSec.toLocaleString()}
                    </span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-2">
                    <div
                      className={`h-2 rounded-full transition-all ${
                        imbalanced ? 'bg-yellow-500' : 'bg-green-500'
                      }`}
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Connected Clients */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium">Connected Clients</span>
            </div>
            <span className="text-xs text-muted-foreground">
              Avg: {means.clients.toFixed(0)}
            </span>
          </div>
          <div className="space-y-2">
            {statsArray.map((node) => {
              const maxClients = Math.max(...statsArray.map((n) => n.connectedClients));
              const percentage = maxClients > 0 ? (node.connectedClients / maxClients) * 100 : 0;
              const imbalanced = isImbalanced(node.nodeId);

              return (
                <div key={node.nodeId} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className={getDeviationColor(node.connectedClients, means.clients)}>
                      {node.nodeAddress}
                    </span>
                    <span className="font-medium">
                      {node.connectedClients} clients
                    </span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-2">
                    <div
                      className={`h-2 rounded-full transition-all ${
                        imbalanced ? 'bg-yellow-500' : 'bg-purple-500'
                      }`}
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Legend */}
        {imbalancedNodes.length > 0 && (
          <div className="pt-3 border-t">
            <div className="flex items-center gap-2 text-xs text-yellow-600">
              <AlertTriangle className="w-3 h-3" />
              <span>
                {imbalancedNodes.length} node{imbalancedNodes.length !== 1 ? 's' : ''} showing
                significant deviation (&gt;20%) from cluster average
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
