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
}
