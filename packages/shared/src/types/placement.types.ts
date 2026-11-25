export type PlacementMode = 'observe' | 'recommend' | 'approve' | 'auto';

export const PLACEMENT_MODES: readonly PlacementMode[] = ['observe', 'recommend', 'approve', 'auto'];

export const PLACEMENT_DEFAULT_MODE: PlacementMode = 'observe';

export interface PlacementPolicy {
  connectionId: string;
  mode: PlacementMode;
  updatedAt: number;
}

export type PlacementSupportReason =
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
