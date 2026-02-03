import { useMemo, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { RefreshCw, Server, Info } from 'lucide-react';
import { useCluster } from '../hooks/useCluster';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { metricsApi } from '../api/metrics';
import { ClusterHealthCard } from '../components/cluster/ClusterHealthCard';
import { ClusterTopology } from '../components/cluster/ClusterTopology';
import { SlotHeatmap } from '../components/cluster/SlotHeatmap';
import { ClusterNodesTable } from '../components/cluster/ClusterNodesTable';
import { NodeStatsComparison } from '../components/cluster/NodeStatsComparison';
import { ClusterSlowlog } from '../components/cluster/ClusterSlowlog';
import { ReplicationLag } from '../components/cluster/ReplicationLag';
import { SlotMigrations } from '../components/cluster/SlotMigrations';
import { buildSlotNodeMap } from '../types/cluster';

export function ClusterDashboard() {
  const { currentConnection } = useConnection();
  const {
    isClusterMode,
    isLoading,
    error,
    nodes,
    masters,
    replicas,
    slotStats,
    hasSlotStats,
    health,
    refetch,
  } = useCluster();

  // Stabilize fetcher functions to prevent unnecessary re-renders
  const nodeStatsFetcher = useCallback(
    (signal?: AbortSignal) => metricsApi.getClusterNodeStats(signal),
    []
  );

  const migrationsFetcher = useCallback(
    (signal?: AbortSignal) => metricsApi.getSlotMigrations(signal),
    []
  );

  // Only enable polling once we have successfully loaded cluster nodes
  // Use useMemo to prevent re-enabling when isLoading toggles during refresh
  const shouldPoll = useMemo(() => {
    return isClusterMode && nodes.length > 0;
  }, [isClusterMode, nodes.length]);

  const { data: nodeStats } = usePolling({
    fetcher: nodeStatsFetcher,
    interval: 5000,
    enabled: shouldPoll,
    refetchKey: currentConnection?.id,
  });

  const { data: migrations } = usePolling({
    fetcher: migrationsFetcher,
    interval: 5000,
    enabled: shouldPoll,
    refetchKey: currentConnection?.id,
  });

  // Memoize slot-to-node mapping separately for reuse
  const slotNodeMap = useMemo(() => buildSlotNodeMap(nodes), [nodes]);

  // Top slots by key count
  const topSlots = useMemo(() => {
    if (!slotStats) return [];

    return Object.entries(slotStats)
      .map(([slot, stats]) => {
        const slotNum = parseInt(slot, 10);
        // Skip invalid slot numbers
        if (isNaN(slotNum)) return null;

        return {
          slot: slotNum,
          keyCount: stats.key_count,
          expiresCount: stats.expires_count,
          totalReads: stats.total_reads,
          totalWrites: stats.total_writes,
          nodeId: slotNodeMap.get(slotNum) || 'unknown',
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null && s.keyCount > 0)
      .sort((a, b) => b.keyCount - a.keyCount)
      .slice(0, 10);
  }, [slotStats, slotNodeMap]);

  // Find node address by ID
  const getNodeAddress = (nodeId: string): string => {
    const node = nodes.find((n) => n.id === nodeId);
    return node?.address || nodeId.substring(0, 12);
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Cluster Overview</h1>
          <p className="text-muted-foreground">Loading cluster information...</p>
        </div>
        <div className="grid md:grid-cols-4 gap-4">
          <Skeleton className="h-[200px]" />
          <Skeleton className="h-[200px] md:col-span-3" />
        </div>
      </div>
    );
  }

  if (!isClusterMode) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Cluster Overview</h1>
        </div>
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Server className="w-16 h-16 text-muted-foreground mb-4 opacity-50" />
              <h3 className="text-xl font-semibold mb-2">Standalone Mode</h3>
              <p className="text-muted-foreground max-w-md">
                This instance is running in standalone mode. Cluster features are available
                when connected to a Valkey/Redis cluster.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Cluster Overview</h1>
        </div>
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Info className="w-16 h-16 text-red-500 mb-4 opacity-50" />
              <h3 className="text-xl font-semibold mb-2 text-red-500">Error Loading Cluster</h3>
              <p className="text-muted-foreground max-w-md">
                {error instanceof Error ? error.message : 'An unknown error occurred'}
              </p>
              <button
                type="button"
                onClick={refetch}
                className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
              >
                Retry
              </button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Cluster Overview</h1>
          <p className="text-muted-foreground">
            Monitoring {masters.length} master nodes and {replicas.length} replicas
          </p>
        </div>
        <button
          type="button"
          onClick={refetch}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="nodes">Nodes</TabsTrigger>
          <TabsTrigger value="replication">Replication</TabsTrigger>
          <TabsTrigger value="slowlog">Slowlog</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-4">
          {/* Health Card + Topology */}
          <div className="grid md:grid-cols-4 gap-4">
            <div className="md:col-span-1">
              <ClusterHealthCard
                health={health}
                masterCount={masters.length}
                replicaCount={replicas.length}
              />
            </div>
            <div className="md:col-span-3">
              <ClusterTopology nodes={nodes} nodeStats={nodeStats || undefined} />
            </div>
          </div>

          {/* Heatmap + Migrations */}
          <div className="grid md:grid-cols-2 gap-4">
            <SlotHeatmap slotStats={slotStats} nodes={nodes} hasSlotStats={hasSlotStats} />
            <SlotMigrations migrations={migrations || undefined} />
          </div>

          {/* Top Slots */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Top Slots by Key Count</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Slots with the highest number of keys
              </p>
            </CardHeader>
            <CardContent>
              {hasSlotStats && topSlots.length > 0 ? (
                <div className="space-y-2">
                  {topSlots.map((slotData, idx) => (
                    <div
                      key={slotData.slot}
                      className="flex items-center justify-between p-3 bg-muted/30 rounded text-sm"
                    >
                      <div className="flex items-center gap-3">
                        <div className="text-xs font-medium text-muted-foreground w-6">
                          #{idx + 1}
                        </div>
                        <div>
                          <div className="font-medium">Slot {slotData.slot}</div>
                          <div className="text-xs text-muted-foreground font-mono">
                            {getNodeAddress(slotData.nodeId)}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold">{slotData.keyCount.toLocaleString()}</div>
                        <div className="text-xs text-muted-foreground">keys</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : hasSlotStats ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Info className="w-12 h-12 mx-auto mb-3 opacity-50" />
                  <p>No keys found in cluster</p>
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Info className="w-12 h-12 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">Slot statistics not available</p>
                  <p className="text-xs mt-1">Requires Valkey 8.0+</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Nodes Tab */}
        <TabsContent value="nodes" className="space-y-4">
          <NodeStatsComparison nodeStats={nodeStats || undefined} />
          <ClusterNodesTable nodes={nodes} />
        </TabsContent>

        {/* Replication Tab */}
        <TabsContent value="replication" className="space-y-4">
          <ReplicationLag nodes={nodes} nodeStats={nodeStats || undefined} />
        </TabsContent>

        {/* Slowlog Tab */}
        <TabsContent value="slowlog" className="space-y-4">
          <ClusterSlowlog />
        </TabsContent>
      </Tabs>
    </div>
  );
}
