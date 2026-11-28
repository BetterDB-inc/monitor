import type { PlacementAction, PlacementStep, PlacementStepRead } from '@betterdb/shared';

type ColumnKind = 'text' | 'nullableText' | 'json' | 'number' | 'nullableNumber';

type ColumnMap<T> = { [K in keyof T]-?: [column: string, kind: ColumnKind] };

export const PLACEMENT_ACTION_COLUMNS: ColumnMap<PlacementAction> = {
  id: ['id', 'text'],
  connectionId: ['connection_id', 'text'],
  clusterNodes: ['cluster_nodes', 'json'],
  kind: ['kind', 'text'],
  state: ['state', 'text'],
  modeAtCreation: ['mode_at_creation', 'text'],
  plan: ['plan', 'json'],
  settingsSnapshot: ['policy_snapshot', 'json'],
  policyVersion: ['policy_version', 'number'],
  gateDecisions: ['gate_decisions', 'json'],
  approvedBy: ['approved_by', 'json'],
  loadBefore: ['load_before', 'json'],
  loadProjected: ['load_projected', 'json'],
  loadMeasured: ['load_measured', 'json'],
  verdict: ['verdict', 'json'],
  sourceShardId: ['source_shard_id', 'text'],
  rollbackOf: ['rollback_of', 'nullableText'],
  rolledBackBy: ['rolled_back_by', 'nullableText'],
  createdAt: ['created_at', 'number'],
  approvedAt: ['approved_at', 'nullableNumber'],
  startedAt: ['started_at', 'nullableNumber'],
  endedAt: ['ended_at', 'nullableNumber'],
  verifiedAt: ['verified_at', 'nullableNumber'],
  anomalyEventIds: ['anomaly_event_ids', 'json'],
  message: ['message', 'nullableText'],
};

export const PLACEMENT_STEP_COLUMNS: ColumnMap<PlacementStep> = {
  actionId: ['action_id', 'text'],
  index: ['step_index', 'number'],
  state: ['state', 'text'],
  sourceNodeId: ['source_node_id', 'text'],
  targetNodeId: ['target_node_id', 'text'],
  targetShardId: ['target_shard_id', 'text'],
  targetAddr: ['target_addr', 'text'],
  ranges: ['ranges', 'json'],
  jobsBefore: ['jobs_before', 'json'],
  job: ['job', 'json'],
  cancelRequestedAt: ['cancel_requested_at', 'nullableNumber'],
  cancelAcceptedAt: ['cancel_accepted_at', 'nullableNumber'],
  failedBeforeCancel: ['failed_before_cancel', 'json'],
  bytesEstimated: ['bytes_estimated', 'number'],
  keysMoved: ['keys_moved', 'number'],
  slotsMoved: ['slots_moved', 'number'],
  slotCpuBefore: ['slot_cpu_before', 'number'],
  sendingAt: ['sending_at', 'nullableNumber'],
  startedAt: ['started_at', 'nullableNumber'],
  endedAt: ['ended_at', 'nullableNumber'],
};

function toColumn(kind: ColumnKind, value: unknown): unknown {
  if (kind === 'json') return value === null || value === undefined ? null : JSON.stringify(value);
  return value ?? null;
}

function fromColumn(kind: ColumnKind, value: unknown): unknown {
  if (kind === 'json') {
    if (value === null || value === undefined) return null;
    return typeof value === 'string' ? JSON.parse(value) : value;
  }
  if (kind === 'number') return Number(value);
  if (kind === 'nullableNumber')
    return value === null || value === undefined ? null : Number(value);
  if (kind === 'nullableText') return value ?? null;
  return value;
}

export function placementColumns<T extends object>(
  map: ColumnMap<T>,
  values: Partial<T>,
  skip: readonly (keyof T)[] = [],
): { columns: string[]; params: unknown[] } {
  const columns: string[] = [];
  const params: unknown[] = [];
  for (const key of Object.keys(values) as (keyof T)[]) {
    const entry = map[key];
    if (!entry || values[key] === undefined || skip.includes(key)) continue;
    columns.push(entry[0]);
    params.push(toColumn(entry[1], values[key]));
  }
  return { columns, params };
}

export function placementFromRow<T extends object>(
  map: ColumnMap<T>,
  row: Record<string, unknown>,
): T {
  const value = {} as Record<keyof T, unknown>;
  for (const key of Object.keys(map) as (keyof T)[]) {
    const [column, kind] = map[key];
    value[key] = fromColumn(kind, row[column]);
  }
  return value as T;
}

export function placementStepReadOf(row: Record<string, unknown>): PlacementStepRead {
  return {
    ...placementFromRow(PLACEMENT_STEP_COLUMNS, row),
    sourceShardId: String(row.action_source_shard_id),
  };
}

export function placementPageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.min(Math.max(Math.floor(limit), 1), 200);
}

export function placementCursor(action: Pick<PlacementAction, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify([action.createdAt, action.id])).toString('base64url');
}

function decodeCursor(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function parsePlacementCursor(cursor: string): { createdAt: number; id: string } {
  const decoded = decodeCursor(cursor);
  if (Array.isArray(decoded)) {
    const [createdAt, id] = decoded;
    if (typeof createdAt === 'number' && Number.isFinite(createdAt) && typeof id === 'string') {
      return { createdAt, id };
    }
  }
  throw new Error('Invalid placement action cursor');
}

export class PlacementLockTaken extends Error {}
