export type PlacementMode = 'observe' | 'recommend' | 'approve' | 'auto';

export const PLACEMENT_MODES: readonly PlacementMode[] = ['observe', 'recommend', 'approve', 'auto'];

export const PLACEMENT_DEFAULT_MODE: PlacementMode = 'observe';

export interface PlacementPolicy {
  connectionId: string;
  mode: PlacementMode;
  updatedAt: number;
}

export type PlacementSupportReason =
  | 'not_connected'
  | 'not_cluster'
  | 'provider_managed'
  | 'per_node_connections'
  | 'slot_stats_off'
  | 'not_dialed'
  | 'server_version'
  | 'copy_only'
  | 'command_unavailable'
  | 'acl'
  | 'flag_off'
  | 'memory_storage'
  | 'no_sign_in';

export interface PlacementSupportIssue {
  reason: PlacementSupportReason;
  detail: string;
  provider?: string;
}

export interface PlacementModeSupport {
  available: boolean;
  blockedBy: PlacementSupportReason | null;
}

export interface PlacementSupport {
  issues: PlacementSupportIssue[];
  modes: Record<PlacementMode, PlacementModeSupport>;
}

export interface PlacementShardBalance {
  shardId: string;
  address: string;
  slotCount: number;
  cpuUsecPerSecond: number;
  cpuShare: number | null;
  networkShare: number | null;
  ratio: number | null;
  overTrigger: boolean;
}

export interface PlacementBalance {
  sampledAt: number;
  settling: boolean;
  medianCpuUsecPerSecond: number;
  triggerRatio: number;
  resolveRatio: number;
  shards: PlacementShardBalance[];
}

export const PLACEMENT_SETTABLE_MODES: readonly PlacementMode[] = ['observe', 'recommend'];

export interface PlacementStatus {
  connectionId: string;
  mode: PlacementMode;
  effectiveMode: PlacementMode;
  selectableModes: PlacementMode[];
  support: PlacementSupport;
  balance: PlacementBalance | null;
}
