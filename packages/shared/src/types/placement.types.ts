import type { ActorVia } from './workspace';

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
  | 'incident_history'
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

export type PlacementActionKind = 'spread' | 'rollback';

export type PlacementActionState =
  | 'proposed'
  | 'approved'
  | 'running'
  | 'verifying'
  | 'succeeded'
  | 'ineffective'
  | 'inconclusive'
  | 'rejected'
  | 'expired'
  | 'aborted'
  | 'aborted_pending'
  | 'failed'
  | 'rolling_back'
  | 'rolled_back'
  | 'rollback_blocked'
  | 'rollback_failed';

export const PLACEMENT_OPEN_STATES: readonly PlacementActionState[] = [
  'proposed',
  'approved',
  'running',
  'verifying',
  'rolling_back',
];

export const PLACEMENT_TERMINAL_STATES: readonly PlacementActionState[] = [
  'succeeded',
  'ineffective',
  'inconclusive',
  'rejected',
  'expired',
  'aborted',
  'aborted_pending',
  'failed',
  'rolled_back',
  'rollback_blocked',
  'rollback_failed',
];

export type PlacementStepState =
  | 'planned'
  | 'sending'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface PlacementApprover {
  source: 'ui' | 'mcp' | 'system';
  userId: string;
  email: string;
  via: ActorVia;
  tokenId: string | null;
}

export interface PlacementGateDecision {
  at: number;
  stepIndex: number | null;
  result: PlacementGateResult;
}

export interface PlacementAction {
  id: string;
  connectionId: string;
  clusterNodes: string[];
  kind: PlacementActionKind;
  state: PlacementActionState;
  modeAtCreation: PlacementMode;
  plan: unknown;
  settingsSnapshot: PlacementSettings;
  policyVersion: number;
  gateDecisions: PlacementGateDecision[];
  approvedBy: PlacementApprover | null;
  loadBefore: unknown | null;
  loadProjected: unknown | null;
  loadMeasured: unknown | null;
  verdict: unknown | null;
  sourceShardId: string;
  rollbackOf: string | null;
  rolledBackBy: string | null;
  createdAt: number;
  approvedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  verifiedAt: number | null;
  anomalyEventIds: string[];
  message: string | null;
}

export interface PlacementStepJob {
  jobName?: string;
  state: string;
  phase?: string;
  message?: string;
}

export interface PlacementStep {
  actionId: string;
  index: number;
  state: PlacementStepState;
  sourceNodeId: string;
  targetNodeId: string;
  targetShardId: string;
  targetAddr: string;
  ranges: [number, number][];
  jobsBefore: string[] | null;
  job: PlacementStepJob | null;
  cancelRequestedAt: number | null;
  cancelAcceptedAt: number | null;
  failedBeforeCancel: string[] | null;
  bytesEstimated: number;
  keysMoved: number;
  slotsMoved: number;
  slotCpuBefore: number;
  sendingAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
}

export interface PlacementActionListParams {
  states?: PlacementActionState[];
  from?: number;
  to?: number;
  cursor?: string;
  limit?: number;
}

export interface PlacementActionPage {
  items: PlacementAction[];
  nextCursor: string | null;
}

export type PlacementActionPatch = Partial<Omit<PlacementAction, 'id' | 'connectionId'>> & {
  state: PlacementActionState;
};

export type PlacementStepPatch = Partial<Omit<PlacementStep, 'actionId' | 'index'>>;

export interface PlacementStepRead extends PlacementStep {
  sourceShardId: string;
}
