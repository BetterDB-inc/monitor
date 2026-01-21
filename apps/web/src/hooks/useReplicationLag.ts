import { useMemo } from 'react';
import type { ReplicationLagInfo, NodeStats } from '../types/cluster';
import type { ClusterNode } from '../types/metrics';

export function useReplicationLag(nodes: ClusterNode[], nodeStats?: NodeStats[]) {
  const lagData = useMemo<ReplicationLagInfo[]>(() => {
    if (!nodes || nodes.length === 0) {
      return [];
    }

    const result: ReplicationLagInfo[] = [];

    // Find all replicas and calculate their lag
    const replicas = nodes.filter((n) => n.flags.includes('slave') || n.flags.includes('replica'));

    for (const replica of replicas) {
      const masterId = replica.master && replica.master !== '-' ? replica.master : undefined;
      if (!masterId) continue;

      // Find the master node
      const master = nodes.find((n) => n.id === masterId);
      if (!master) continue;

      // Try to get detailed stats if available
      const replicaStats = nodeStats?.find((s) => s.nodeId === replica.id);
      const masterStats = nodeStats?.find((s) => s.nodeId === master.id);

      // If we have detailed stats, calculate precise lag
      if (replicaStats && masterStats) {
        // Calculate offset difference
        const masterOffset = masterStats.replicationOffset || 0;
        const replicaOffset = replicaStats.replicationOffset || 0;
        const offsetDiff = masterOffset - replicaOffset;

        // Get lag in milliseconds from master_last_io_seconds_ago
        const lagMs = (replicaStats.masterLastIoSecondsAgo || 0) * 1000;

        // Determine link status
        const linkStatus: 'up' | 'down' =
          replicaStats.masterLinkStatus === 'up' ? 'up' : 'down';

        // Determine lag status
        let status: ReplicationLagInfo['status'];
        if (linkStatus === 'down') {
          status = 'disconnected';
        } else if (offsetDiff === 0) {
          status = 'in-sync';
        } else if (offsetDiff < 1000 && lagMs < 100) {
          status = 'slight-lag';
        } else {
          status = 'lagging';
        }

        result.push({
          masterId: master.id,
          masterAddress: master.address,
          replicaId: replica.id,
          replicaAddress: replica.address,
          offsetDiff,
          lagMs,
          linkStatus,
          status,
        });
      } else {
        // Fallback: Show basic replication relationship without detailed stats
        // Determine basic status from cluster node flags
        const isHealthy = replica.linkState === 'connected' && !replica.flags.includes('fail');
        const linkStatus: 'up' | 'down' = isHealthy ? 'up' : 'down';
        const status: ReplicationLagInfo['status'] = isHealthy ? 'in-sync' : 'disconnected';

        result.push({
          masterId: master.id,
          masterAddress: master.address,
          replicaId: replica.id,
          replicaAddress: replica.address,
          offsetDiff: 0, // Unknown without stats
          lagMs: 0, // Unknown without stats
          linkStatus,
          status,
        });
      }
    }

    return result;
  }, [nodes, nodeStats]);

  const hasLaggingReplicas = useMemo(
    () => lagData.some((l) => l.status === 'lagging' || l.status === 'disconnected'),
    [lagData]
  );

  const maxLagMs = useMemo(() => {
    if (lagData.length === 0) return 0;
    return Math.max(...lagData.map((l) => l.lagMs));
  }, [lagData]);

  const maxOffsetDiff = useMemo(() => {
    if (lagData.length === 0) return 0;
    return Math.max(...lagData.map((l) => l.offsetDiff));
  }, [lagData]);

  return {
    lagData,
    hasLaggingReplicas,
    maxLagMs,
    maxOffsetDiff,
  };
}
