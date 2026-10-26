export type CaptureSessionStatus =
  | 'running'
  | 'completed'
  | 'truncated'
  | 'failed'
  | 'skipped';

export type CaptureSessionSource = 'manual' | 'trigger' | 'schedule';

export interface StoredCaptureSession {
  id: string;
  connectionId: string;
  status: CaptureSessionStatus;
  source: CaptureSessionSource;
  triggerId?: string;
  scheduleId?: string;
  requestedBy?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  byteCount: number;
  lineCount: number;
  byteCap: number;
  lineCap: number;
  terminationReason?: string;
  /** When set, the session targeted a single cluster node (host:port). Null for single-instance or future fan-out (where per-node attribution lives in capture_chunks). */
  targetNode?: string;
  /** Per-node status segments for fan-out captures. Empty/undefined for single-node sessions. */
  nodeSegments?: CaptureNodeSegment[];
  /**
   * Session-boundary `INFO stats` samples, one entry per captured node.
   * Undefined for sessions recorded before counter snapshots existed.
   */
  counterSnapshots?: CaptureCounterSnapshots;
}

export interface CaptureNodeSegment {
  /** Cluster-discovery node id. */
  nodeId: string;
  /** Node address (host:port) at capture time. */
  address: string;
  status: CaptureSessionStatus;
  byteCount: number;
  lineCount: number;
  endedAt?: number;
  terminationReason?: string;
}

export interface CaptureSessionQueryOptions {
  connectionId?: string;
  status?: CaptureSessionStatus;
  source?: CaptureSessionSource;
  startedAfter?: number;
  startedBefore?: number;
  limit?: number;
  offset?: number;
}

export type CaptureTriggerStatus =
  | 'configured'
  | 'queued'
  | 'fired'
  | 'skipped'
  | 'expired'
  | 'cancelled';

export interface StoredCaptureTrigger {
  id: string;
  connectionId: string;
  metricType: string;
  anomalyType: string;
  expiresAt: number;
  createdAt: number;
  createdBy?: string;
  status: CaptureTriggerStatus;
  firedAt?: number;
  firedSessionId?: string;
  skipReason?: string;
}

export interface CaptureTriggerQueryOptions {
  connectionId?: string;
  status?: CaptureTriggerStatus;
  limit?: number;
  offset?: number;
}

export interface CaptureTriggerPatch {
  status?: CaptureTriggerStatus;
  firedAt?: number;
  firedSessionId?: string;
  skipReason?: string;
}

export type ScheduledCaptureStatus = 'enabled' | 'disabled';

export interface StoredScheduledCapture {
  id: string;
  connectionId: string;
  /** Fixed interval in seconds. Mutually exclusive with cronExpression. */
  intervalSeconds?: number;
  /** Standard 5- or 6-field cron expression. Mutually exclusive with intervalSeconds. */
  cronExpression?: string;
  durationMs: number;
  status: ScheduledCaptureStatus;
  createdAt: number;
  createdBy?: string;
  lastFiredAt?: number;
  lastFiredSessionId?: string;
  lastSkipReason?: string;
}

export interface ScheduledCaptureQueryOptions {
  connectionId?: string;
  status?: ScheduledCaptureStatus;
  limit?: number;
  offset?: number;
}

export interface ScheduledCapturePatch {
  status?: ScheduledCaptureStatus;
  intervalSeconds?: number;
  cronExpression?: string;
  durationMs?: number;
  lastFiredAt?: number;
  lastFiredSessionId?: string;
  lastSkipReason?: string;
}

export interface StoredCaptureChunk {
  sessionId: string;
  chunkIndex: number;
  bytes: Buffer;
  lineCount: number;
  firstTs: number;
  lastTs: number;
  /** Cluster node attribution for fan-out chunks; null for single-node sessions. */
  nodeId?: string;
}

/** Mutable subset of {@link StoredCaptureSession} that can be patched after insert. */
export interface CaptureSessionPatch {
  status?: CaptureSessionStatus;
  endedAt?: number;
  durationMs?: number;
  byteCount?: number;
  lineCount?: number;
  terminationReason?: string;
  nodeSegments?: CaptureNodeSegment[];
  counterSnapshots?: CaptureCounterSnapshots;
}

/**
 * Monotonic `INFO stats` counters sampled at capture start and end. Gauges
 * (used_memory, connected_clients, …) are intentionally excluded: a start/end
 * difference of a gauge is not "activity during the window".
 */
export const CAPTURE_COUNTER_FIELDS = [
  'total_commands_processed',
  'total_connections_received',
  'rejected_connections',
  'keyspace_hits',
  'keyspace_misses',
  'expired_keys',
  'evicted_keys',
  'total_net_input_bytes',
  'total_net_output_bytes',
  'total_error_replies',
  'acl_access_denied_auth',
  'acl_access_denied_cmd',
  'acl_access_denied_key',
  'acl_access_denied_channel',
  'sync_full',
  'sync_partial_ok',
  'sync_partial_err',
] as const;

export type CaptureCounterName = (typeof CAPTURE_COUNTER_FIELDS)[number];

export const CAPTURE_COUNTER_LABELS: Record<CaptureCounterName, string> = {
  total_commands_processed: 'Commands processed',
  total_connections_received: 'Connections received',
  rejected_connections: 'Rejected connections',
  keyspace_hits: 'Keyspace hits',
  keyspace_misses: 'Keyspace misses',
  expired_keys: 'Expired keys',
  evicted_keys: 'Evicted keys',
  total_net_input_bytes: 'Network in',
  total_net_output_bytes: 'Network out',
  total_error_replies: 'Error replies',
  acl_access_denied_auth: 'ACL denied (auth)',
  acl_access_denied_cmd: 'ACL denied (command)',
  acl_access_denied_key: 'ACL denied (key)',
  acl_access_denied_channel: 'ACL denied (channel)',
  sync_full: 'Full resyncs',
  sync_partial_ok: 'Partial resyncs (ok)',
  sync_partial_err: 'Partial resyncs (failed)',
};

export interface CaptureCounterSample {
  /** Unix ms when the INFO reply was received. */
  capturedAt: number;
  /** Counters the server reported. A field this server version does not emit is absent, never 0. */
  counters: Partial<Record<CaptureCounterName, number>>;
}

export interface CaptureNodeCounterSnapshot {
  /** Cluster-discovery node id. Undefined for a session on the connection's own client. */
  nodeId?: string;
  /** host:port at capture time, when known. */
  address?: string;
  start: CaptureCounterSample | null;
  end: CaptureCounterSample | null;
  /** Why the start sample is missing (timeout, connection error), truncated to 200 chars. */
  startError?: string;
  /** Why the end sample is missing. */
  endError?: string;
}

export interface CaptureCounterSnapshots {
  version: 1;
  nodes: CaptureNodeCounterSnapshot[];
}

/**
 * complete: every node has both samples and no counter went backwards.
 * partial: at least one node measured, but some node lacks a sample or reset a counter.
 * unavailable: no node has both samples (including sessions recorded before this field existed).
 */
export type CaptureCounterCoverage = 'complete' | 'partial' | 'unavailable';

export interface CaptureCounterReset {
  /** Node address (or id) whose counters went backwards during the window. */
  node: string;
  counters: CaptureCounterName[];
}

export interface CaptureCounterDeltas {
  coverage: CaptureCounterCoverage;
  nodesTotal: number;
  nodesMeasured: number;
  /** Longest start→end sample span across measured nodes; null when unavailable. */
  windowMs: number | null;
  /** Sum of end − start across measured nodes; null when no node reported the counter on both samples. */
  deltas: Record<CaptureCounterName, number | null>;
  resets: CaptureCounterReset[];
  derived: {
    /** deltas.total_commands_processed / windowMs, per second. */
    commandsPerSec: number | null;
    /** hits / (hits + misses) over the window; null when there were no lookups. */
    keyspaceHitRatio: number | null;
  };
}
