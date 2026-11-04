import { useMemo } from 'react';
import { usePolling } from './usePolling';
import { useCapabilities } from './useCapabilities';
import { metricsApi } from '../api/metrics';
import type { ClusterNode } from '../types/metrics';
import { CLUSTER_TOTAL_SLOTS, type ClusterHealth } from '../types/cluster';

export function useCluster() {
  const { capabilities } = useCapabilities();

  // Fetch INFO to check if cluster mode is enabled
  const {
    data: serverInfo,
    error: serverInfoError,
    loading: serverInfoLoading,
    refresh: refreshServerInfo,
  } = usePolling({
    fetcher: () => metricsApi.getInfo(['cluster']),
    interval: 30000,
    enabled: true,
  });

  // Check if cluster mode is enabled from INFO
  const isClusterMode = serverInfo?.cluster?.cluster_enabled === '1';

  // Fetch cluster info (only if in cluster mode)
  const {
    data: info,
    error: infoError,
    loading: infoLoading,
    refresh: refreshInfo,
  } = usePolling({
    fetcher: () => metricsApi.getClusterInfo(),
    interval: 30000,
    enabled: isClusterMode,
  });

  // Fetch cluster nodes (only if in cluster mode)
  const {
    data: nodes,
    error: nodesError,
    loading: nodesLoading,
    refresh: refreshNodes,
  } = usePolling({
    fetcher: () => metricsApi.getClusterNodes(),
    interval: 30000,
    enabled: isClusterMode,
  });

  // Fetch slot stats (only if available and in cluster mode)
  const hasSlotStats = capabilities?.hasClusterSlotStats ?? false;
  const {
    data: slotStatsResult,
    error: slotStatsError,
    refresh: refreshSlotStats,
  } = usePolling({
    fetcher: () => metricsApi.getSlotStats('key-count', CLUSTER_TOTAL_SLOTS),
    interval: 30000,
    enabled: isClusterMode && hasSlotStats,
  });

  // Derived state
  const isLoading = serverInfoLoading || (isClusterMode && (infoLoading || nodesLoading));

  const errors = {
    serverInfo: serverInfoError,
    clusterInfo: infoError,
    nodes: nodesError,
    slotStats: slotStatsError,
  };

  const hasError = Object.values(errors).some((e) => e !== null);
  const error = hasError
    ? serverInfoError || (isClusterMode ? (infoError || nodesError) : null)
    : null;

  const { masters, replicas } = useMemo(() => {
    if (!nodes) return { masters: [], replicas: [] };

    const masters: ClusterNode[] = [];
    const replicas: ClusterNode[] = [];

    for (const node of nodes) {
      if (node.flags.includes('master')) {
        masters.push(node);
      } else if (node.flags.includes('slave') || node.flags.includes('replica')) {
        replicas.push(node);
      }
    }

    return { masters, replicas };
  }, [nodes]);

  const health = useMemo<ClusterHealth>(() => {
    if (!info) {
      return {
        status: 'failing',
        slotsOk: 0,
        slotsFail: 0,
        slotsPfail: 0,
        slotsAssigned: 0,
        totalSlots: CLUSTER_TOTAL_SLOTS,
      };
    }

    const slotsAssigned = parseInt(info.cluster_slots_assigned || '0', 10);
    const slotsFail = parseInt(info.cluster_slots_fail || '0', 10);
    const slotsPfail = parseInt(info.cluster_slots_pfail || '0', 10);
    const slotsOk = parseInt(info.cluster_slots_ok || '0', 10);
    const clusterState = info.cluster_state || 'fail';

    let status: ClusterHealth['status'];
    if (clusterState === 'ok' && slotsFail === 0 && slotsPfail === 0) {
      status = 'healthy';
    } else if (slotsFail > 0) {
      status = 'failing';
    } else {
      status = 'degraded';
    }

    return {
      status,
      slotsOk,
      slotsFail,
      slotsPfail,
      slotsAssigned,
      totalSlots: CLUSTER_TOTAL_SLOTS,
    };
  }, [info]);

  const refetch = () => {
    refreshServerInfo();
    if (isClusterMode) {
      refreshInfo();
      refreshNodes();
      if (hasSlotStats) {
        refreshSlotStats();
      }
    }
  };

  return {
    isClusterMode,
    isLoading,
    error,
    errors,
    info,
    nodes: nodes || [],
    masters,
    replicas,
    slotStats: slotStatsResult?.stats || null,
    slotStatsFailedNodes: slotStatsResult?.failedNodes ?? [],
    hasSlotStats,
    health,
    refetch,
  };
}
