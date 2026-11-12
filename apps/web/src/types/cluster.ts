export const CLUSTER_TOTAL_SLOTS = 16384;
export const CLUSTER_GRID_SIZE = 128; // 128x128 = 16384 slots
// https://valkey.io/topics/cluster-spec/
// https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/


export interface ClusterHealth {
  status: 'healthy' | 'degraded' | 'failing';
  slotsOk: number;
  slotsFail: number;
  slotsPfail: number;
  slotsAssigned: number;
  totalSlots: typeof CLUSTER_TOTAL_SLOTS;
}

// Re-export from metrics for convenience
export type { ClusterNode, SlotStatsMetric, SlotStats } from './metrics';

// New cluster monitoring types

export interface DiscoveredNode {
  id: string;
  address: string;
  role: 'master' | 'replica';
  masterId?: string;
  slots: number[][];
  healthy: boolean;
  availabilityZone?: string;
  shardId?: string;
}

export interface NodeStats {
  nodeId: string;
  nodeAddress: string;
  role: 'master' | 'replica';
  memoryUsed: number;
  memoryPeak: number;
  memoryFragmentationRatio: number;
  opsPerSec: number;
  connectedClients: number;
  blockedClients: number;
  inputKbps: number;
  outputKbps: number;
  replicationOffset?: number;
  masterLinkStatus?: string;
  masterLastIoSecondsAgo?: number;
  cpuSys?: number;
  cpuUser?: number;
  uptimeSeconds?: number;
}

export interface ClusterSlowlogEntry {
  id: number;
  timestamp: number;
  duration: number;
  command: string[];
  clientAddress: string;
  clientName: string;
  nodeId: string;
  nodeAddress: string;
}

export interface ClusterClientEntry {
  id: string;
  addr: string;
  name: string;
  age: number;
  idle: number;
  flags: string;
  db: number;
  sub: number;
  psub: number;
  multi: number;
  qbuf: number;
  qbufFree: number;
  obl: number;
  oll: number;
  omem: number;
  events: string;
  cmd: string;
  user: string;
  nodeId: string;
  nodeAddress: string;
}

export interface SlotMigration {
  slot: number;
  sourceNodeId: string;
  sourceAddress: string;
  targetNodeId: string;
  targetAddress: string;
  state: 'migrating' | 'importing';
  keysRemaining?: number;
  /** Atomic slot migration (Valkey 9+): the ranges the job moves. */
  slotRange?: string;
  /** Atomic slot migration job state, e.g. "snapshotting". */
  phase?: string;
}

export interface ReplicationLagInfo {
  masterId: string;
  masterAddress: string;
  replicaId: string;
  replicaAddress: string;
  offsetDiff: number;
  lagMs: number;
  linkStatus: 'up' | 'down';
  status: 'in-sync' | 'slight-lag' | 'lagging' | 'disconnected';
}

// Utility functions for cluster operations
export function formatSlotRanges(slots: number[][]): string {
  return slots
    .map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`))
    .join(', ');
}

export function countSlots(slots: number[][]): number {
  return slots.reduce((sum, [start, end]) => sum + (end - start + 1), 0);
}

export function buildSlotNodeMap(nodes: import('./metrics').ClusterNode[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const node of nodes) {
    if (node.flags.includes('master')) {
      for (const [start, end] of node.slots) {
        for (let slot = start; slot <= end; slot++) {
          map.set(slot, node.id);
        }
      }
    }
  }
  return map;
}
