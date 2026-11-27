export type PlacementMode = 'observe' | 'recommend' | 'approve' | 'auto';

export const PLACEMENT_MODES: readonly PlacementMode[] = ['observe', 'recommend', 'approve', 'auto'];

export const PLACEMENT_DEFAULT_MODE: PlacementMode = 'observe';

export interface PlacementMaintenanceWindow {
  days: number[];
  start: string;
  durationMinutes: number;
}

export interface PlacementSettings {
  triggerRatio: number;
  maxCpuShare: number | null;
  maxNetworkShare: number | null;
  nodeCpuLimitUsecPerSecond: number;
  resolveRatio: number;
  sustainMinutes: number;
  slotCooldownDays: number;
  noReturnDays: number;
  maxMigrationsPerHour: number;
  maxBytesPerHour: number;
  maintenanceWindows: PlacementMaintenanceWindow[];
  excludedShardIds: string[];
  excludedSlots: number[];
  abortLatencyMs: number;
  verifyMinutes: number;
  verifyTolerance: number;
  autoRollback: boolean;
}

export const DEFAULT_PLACEMENT_SETTINGS: Readonly<PlacementSettings> = Object.freeze({
  triggerRatio: 2,
  maxCpuShare: null,
  maxNetworkShare: null,
  nodeCpuLimitUsecPerSecond: 800_000,
  resolveRatio: 1.25,
  sustainMinutes: 30,
  slotCooldownDays: 7,
  noReturnDays: 7,
  maxMigrationsPerHour: 4,
  maxBytesPerHour: 2 * 1024 ** 3,
  maintenanceWindows: Object.freeze([]) as unknown as PlacementMaintenanceWindow[],
  excludedShardIds: Object.freeze([]) as unknown as string[],
  excludedSlots: Object.freeze([]) as unknown as number[],
  abortLatencyMs: 50,
  verifyMinutes: 10,
  verifyTolerance: 0.5,
  autoRollback: true,
});

export const PLACEMENT_RESOLVE_RATIO_CAP = 1.5;

export function defaultPlacementSettings(): PlacementSettings {
  return {
    ...DEFAULT_PLACEMENT_SETTINGS,
    maintenanceWindows: [],
    excludedShardIds: [],
    excludedSlots: [],
  };
}

export interface PlacementPolicyInvalid {
  problems: string[];
  exclusionsReadable: boolean;
}

export interface PlacementPolicy {
  connectionId: string;
  mode: PlacementMode;
  settings: PlacementSettings;
  version: number;
  updatedAt: number;
  invalid?: PlacementPolicyInvalid;
}

export type PlacementModeWrite = Pick<PlacementPolicy, 'connectionId' | 'mode' | 'updatedAt'>;

export interface PlacementSettingsWrite {
  connectionId: string;
  settings: PlacementSettings;
  updatedAt: number;
  modeIfNew: PlacementMode;
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
  sustainCpuUsecPerSecond: number;
  sustainRatio: number | null;
  baselineRatio: number | null;
  trigger: PlacementTriggerState;
  warmUntil: number | null;
}

export type PlacementTriggerState = 'over' | 'under' | 'short_history';

export interface PlacementTriggerRead {
  state: PlacementTriggerState;
  overShare: number;
  coveredMs: number;
  firedAt: number | null;
  warmUntil: number | null;
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
  settings: PlacementSettings;
  policyVersion: number;
  policyInvalid: PlacementPolicyInvalid | null;
  recommendations: PlacementRecommendation[];
}

export interface PlacementRecommendation {
  sourceShardId: string;
  targetShardIds: string[];
  gate: PlacementGateResult;
  execution: { available: boolean; blockedBy?: string };
}

export type PlacementBlockerKind =
  | 'unhealthy_node'
  | 'migration_running'
  | 'cluster_state'
  | 'topology_divergence'
  | 'slot_migration_stuck'
  | 'orphaned_slot_keys'
  | 'ghost_membership'
  | 'budget'
  | 'paused'
  | 'unsupported'
  | 'failover'
  | 'fork'
  | 'replication_divergence'
  | 'latency'
  | 'incident'
  | 'excluded'
  | 'cooldown'
  | 'no_return'
  | 'quarantined'
  | 'outside_window'
  | 'coverage'
  | 'unknown';

export type PlacementBlockerScope = 'cluster' | 'source' | 'target';

export interface PlacementBlocker {
  kind: PlacementBlockerKind;
  scope: PlacementBlockerScope;
  nodeId?: string;
  detail: string;
}

export interface PlacementGateResult {
  allowed: boolean;
  blockers: PlacementBlocker[];
  warnings: PlacementBlocker[];
}

export type PlacementGatePurpose = 'approve' | 'auto' | 'rollback';
export interface PlacementPolicySaved extends PlacementStatus {
  exclusionsExpanded: boolean;
  exclusionsExpandProblem: string | null;
}
