/**
 * Capture configuration, namespaced under `capture` on the Redis options object.
 */
export interface CaptureConfig {
  /** Auth token carrying workspace/instance binding. Required. */
  token: string;
  /** Monitor HTTP endpoint base URL. Required. */
  monitorUrl: string;
  /** Monitor connection/instance ID for this Valkey instance. Required. */
  instanceId: string;
  /** Commands per batch before POST. Default: 1000. */
  batchSize?: number;
  /** Flush partial batch on a timer (ms). Default: 5000. */
  flushIntervalMs?: number;
  /** Bounded buffer cap. Default: 100000. */
  maxBufferedCommands?: number;
  /** Capture-window poll interval (ms). Default: 15000. */
  pollIntervalMs?: number;
}

/**
 * A single captured command record.
 */
export interface CapturedCommand {
  /** Stable per-instance connection identifier. */
  connectionId: string;
  /** Command name (e.g. "SET", "GET", "HSET"). */
  name: string;
  /** Command arguments, serialized as strings. */
  args: string[];
  /** Epoch ms when the command was intercepted. */
  ts: number;
}

/**
 * Debugging/observability stats.
 */
export interface CaptureStats {
  /** Total commands captured into the buffer. */
  capturedCount: number;
  /** Commands dropped because the buffer was full. */
  droppedCount: number;
  /** Flush POSTs that failed (batch dropped, no retry). */
  failedFlushCount: number;
  /** Internal errors swallowed by the capture path. */
  errorCount: number;
  /** Commands currently in the buffer awaiting flush. */
  buffered: number;
}

// -- Monitor API shapes (consumed by Monitor in a follow-up) --

/**
 * Request body for the batch POST endpoint.
 */
export interface CaptureBatchRequest {
  connectionId: string;
  commands: CapturedCommand[];
}

/**
 * Response from the capture-window poll endpoint.
 */
export interface CaptureWindowResponse {
  /** Whether a capture window is currently active. */
  active: boolean;
  /** Optional max commands to capture in this window. */
  maxCommands?: number;
  /** Optional max duration (ms) for this window. */
  maxDurationMs?: number;
}
