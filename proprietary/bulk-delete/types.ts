/**
 * Types for the incremental "bulk delete by pattern" feature — a safe,
 * client-driven SCANDEL (valkey/valkey#2623). The dedicated server command is
 * deferred upstream, so the monitor drives SCAN + UNLINK in bounded batches and
 * gets dry-run, pacing, cancellation, cluster fan-out and audit for free.
 */

export type BulkDeleteMode = 'dry-run' | 'execute';

/** Which nodes to walk: just the connected node, or every cluster primary. */
export type BulkDeleteScope = 'node' | 'cluster';

export type BulkDeleteJobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * A single node the engine walks. Wraps a raw client so the engine stays pure
 * and unit-testable with in-memory fakes (no iovalkey dependency).
 */
export interface ScanTarget {
  /** Human-readable node label (address for cluster nodes, 'primary' otherwise). */
  readonly name: string;
  scan(cursor: string, opts: ScanOptions): Promise<ScanResult>;
  /** UNLINK the keys; returns the number the server reports removed. */
  unlink(keys: string[]): Promise<number>;
}

export interface ScanOptions {
  match: string;
  count: number;
  /** Optional server-side SCAN TYPE filter (e.g. 'string', 'hash'). */
  type?: string;
}

export interface ScanResult {
  cursor: string;
  keys: string[];
}

/** Fully-normalized, validated parameters the engine runs against. */
export interface BulkDeleteParams {
  match: string;
  type?: string;
  /** SCAN COUNT hint per batch. */
  count: number;
  mode: BulkDeleteMode;
  /** Hard cap on keys acted upon across all nodes; Infinity means unbounded. */
  maxKeys: number;
  /** Pause between batches to bound latency impact (ms). */
  batchPauseMs: number;
  /** How many matched keys to retain as a preview sample. */
  sampleLimit: number;
}

/** A cluster primary that could not be reached during a fan-out run. */
export interface SkippedNode {
  node: string;
  error: string;
}

export interface NodeProgress {
  node: string;
  matched: number;
  deleted: number;
  batches: number;
  /** True once this node's cursor has returned to 0 (walk complete). */
  cursorDone: boolean;
}

export interface BulkDeleteProgress {
  mode: BulkDeleteMode;
  /** Keys matched by the pattern (post server-side MATCH/TYPE). */
  matched: number;
  /** Keys actually UNLINKed — always 0 in dry-run. */
  deleted: number;
  batches: number;
  nodesTotal: number;
  nodesDone: number;
  /** Stopped early because maxKeys was reached. */
  truncated: boolean;
  cancelled: boolean;
  sampleKeys: string[];
  perNode: NodeProgress[];
}

/** Hooks injected by the caller — all optional, defaulted by the engine. */
export interface BulkDeleteRunHooks {
  sleep?: (ms: number) => Promise<void>;
  /** Polled at each batch boundary; when it returns true the run stops cleanly. */
  isCancelled?: () => boolean;
  /** Called after each processed batch with a snapshot of live progress. */
  onProgress?: (progress: BulkDeleteProgress) => void;
}

/** Raw request fields as they arrive from the API, before normalization. */
export interface BulkDeleteRequestInput {
  match?: string;
  type?: string;
  count?: number;
  scope?: BulkDeleteScope;
  maxKeys?: number;
  batchPauseMs?: number;
  /** Required to allow a catch-all pattern (e.g. '*') to run. */
  confirmDeleteAll?: boolean;
}

/** Persisted audit record for one execute run (dry-runs are not audited). */
export interface BulkDeleteAuditRecord {
  id: string;
  connectionId: string;
  /** Job start time (ms). */
  timestamp: number;
  completedAt: number | null;
  status: BulkDeleteJobStatus;
  match: string;
  type: string | null;
  scope: BulkDeleteScope;
  matched: number;
  deleted: number;
  batches: number;
  nodes: number;
  truncated: boolean;
  /** Cluster primaries skipped because they were unreachable. */
  skippedNodes: string[];
  error: string | null;
  sourceHost: string | null;
  sourcePort: number | null;
}
