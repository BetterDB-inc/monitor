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
}

// -- Command capture (iovalkey-capture wrapper) --

export type CommandCaptureSessionStatus = 'active' | 'stopped' | 'expired';

export interface StoredCommandCaptureSession {
  id: string;
  connectionId: string;
  status: CommandCaptureSessionStatus;
  startedAt: number;
  durationMs: number;
  expiresAt: number;
  stoppedAt?: number;
  commandCap?: number;
  commandCount: number;
  createdBy?: string;
}

export interface CommandCaptureSessionQueryOptions {
  connectionId?: string;
  status?: CommandCaptureSessionStatus;
  limit?: number;
}

export interface StoredCommandCaptureRecord {
  sessionId: string;
  connectionId: string;
  /** Wrapper-side connection identifier (per CaptureValkey instance). */
  wrapperConnectionId: string;
  name: string;
  args: string[];
  ts: number;
}
