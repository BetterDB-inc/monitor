import {
  CAPTURE_COUNTER_FIELDS,
  type CaptureCounterDeltas,
  type CaptureCounterName,
  type CaptureCounterReset,
  type CaptureCounterSample,
  type CaptureCounterSnapshots,
  type CaptureNodeCounterSnapshot,
} from '@betterdb/shared';
import { withTimeout } from '../common/utils/with-timeout';
import { InfoParser } from '../database/parsers/info.parser';

/** Per-sample INFO budget. A capture never waits longer than this on a slow or unreachable node. */
export const COUNTER_SAMPLE_TIMEOUT_MS = 2_000;

const MAX_ERROR_LENGTH = 200;

/** Error code recorded when a node's capture ended without an end sample (open failed, writer threw). */
export const NO_END_SAMPLE = 'no_end_sample';

export interface CounterSampleOutcome {
  sample: CaptureCounterSample | null;
  error?: string;
}

/** Reads one `INFO stats` sample for the connection's own client (nodeId undefined) or one cluster node. */
export type CounterSampleReader = (
  connectionId: string,
  nodeId?: string,
) => Promise<CaptureCounterSample>;

export interface CounterSnapshotTarget {
  nodeId?: string;
  address?: string;
  outcome: CounterSampleOutcome;
}

/** Pick the monotonic counters out of a parsed INFO response. Non-numeric or negative values are skipped. */
export function extractCaptureCounters(
  info: Record<string, unknown>,
): Partial<Record<CaptureCounterName, number>> {
  const stats = info.stats;
  const counters: Partial<Record<CaptureCounterName, number>> = {};
  if (typeof stats !== 'object' || stats === null) {
    return counters;
  }
  const section = stats as Record<string, unknown>;
  for (const field of CAPTURE_COUNTER_FIELDS) {
    const raw = section[field];
    if (typeof raw !== 'string' || raw.trim() === '') {
      continue;
    }
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) {
      counters[field] = value;
    }
  }
  return counters;
}

export function sampleFromInfoText(infoText: string, capturedAt: number): CaptureCounterSample {
  return { capturedAt, counters: extractCaptureCounters(InfoParser.parse(infoText)) };
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

/**
 * Run the reader under {@link COUNTER_SAMPLE_TIMEOUT_MS}. Never rejects:
 * synchronous throws, rejections and timeouts all become `{ sample: null, error }`.
 */
export async function readCounterSample(
  reader: CounterSampleReader,
  connectionId: string,
  nodeId?: string,
  timeoutMs: number = COUNTER_SAMPLE_TIMEOUT_MS,
): Promise<CounterSampleOutcome> {
  try {
    const sample = await withTimeout(
      Promise.resolve().then(() => reader(connectionId, nodeId)),
      timeoutMs,
      `INFO stats timed out after ${timeoutMs} ms`,
    );
    return { sample };
  } catch (error) {
    return { sample: null, error: describeError(error) };
  }
}

/** Key used to match a node's end sample to its start entry. */
export function counterNodeKey(nodeId: string | undefined): string {
  return nodeId ?? '';
}

export function buildStartSnapshots(targets: CounterSnapshotTarget[]): CaptureCounterSnapshots {
  return {
    version: 1,
    nodes: targets.map((target) => {
      const node: CaptureNodeCounterSnapshot = {
        start: target.outcome.sample,
        end: null,
      };
      if (target.nodeId !== undefined) node.nodeId = target.nodeId;
      if (target.address !== undefined) node.address = target.address;
      if (target.outcome.error !== undefined) node.startError = target.outcome.error;
      return node;
    }),
  };
}

/**
 * Attach end samples (keyed by {@link counterNodeKey}) to the start snapshots.
 * A node with no end outcome gets `endError: NO_END_SAMPLE`.
 */
export function withEndSamples(
  snapshots: CaptureCounterSnapshots | undefined,
  endByNode: ReadonlyMap<string, CounterSampleOutcome>,
): CaptureCounterSnapshots | undefined {
  if (snapshots === undefined) {
    return undefined;
  }
  return {
    version: 1,
    nodes: snapshots.nodes.map((node) => {
      const outcome = endByNode.get(counterNodeKey(node.nodeId));
      const next: CaptureNodeCounterSnapshot = { ...node };
      if (outcome === undefined) {
        next.end = null;
        next.endError = NO_END_SAMPLE;
        return next;
      }
      next.end = outcome.sample;
      if (outcome.error !== undefined) {
        next.endError = outcome.error;
      } else {
        delete next.endError;
      }
      return next;
    }),
  };
}

function emptyDeltas(): Record<CaptureCounterName, number | null> {
  const deltas = {} as Record<CaptureCounterName, number | null>;
  for (const field of CAPTURE_COUNTER_FIELDS) {
    deltas[field] = null;
  }
  return deltas;
}

function nodeLabel(node: CaptureNodeCounterSnapshot): string {
  return node.address ?? node.nodeId ?? 'instance';
}

export function deriveCounterRates(
  deltas: Record<CaptureCounterName, number | null>,
  windowMs: number | null,
): CaptureCounterDeltas['derived'] {
  const commands = deltas.total_commands_processed;
  const commandsPerSec =
    commands !== null && windowMs !== null && windowMs > 0 ? commands / (windowMs / 1000) : null;
  const hits = deltas.keyspace_hits;
  const misses = deltas.keyspace_misses;
  const keyspaceHitRatio =
    hits !== null && misses !== null && hits + misses > 0 ? hits / (hits + misses) : null;
  return { commandsPerSec, keyspaceHitRatio };
}

/**
 * Turn stored start/end samples into per-counter deltas summed across nodes.
 *
 * - A node counts as measured only when it has both samples and end.capturedAt >= start.capturedAt.
 * - A counter that went backwards on a node (CONFIG RESETSTAT, restart) is
 *   excluded for that node and reported in `resets`; the other nodes still sum.
 * - The window includes the capture's own footprint on each node:
 *   total_commands_processed can be up to two higher than the captured traffic
 *   (the start INFO and the MONITOR command), and total_connections_received
 *   includes the MONITOR connection (+1). total_net_output_bytes is
 *   deliberately not tracked: the server counts the MONITOR stream it sends to
 *   the capture connection in it.
 */
export function computeCounterDeltas(
  snapshots: CaptureCounterSnapshots | undefined,
): CaptureCounterDeltas {
  const deltas = emptyDeltas();
  const nodes = snapshots?.nodes ?? [];
  const resets: CaptureCounterReset[] = [];
  let windowMs: number | null = null;
  let measured = 0;

  for (const node of nodes) {
    const start = node.start;
    const end = node.end;
    if (start === null || end === null || end.capturedAt < start.capturedAt) {
      continue;
    }
    measured += 1;
    const span = end.capturedAt - start.capturedAt;
    windowMs = windowMs === null ? span : Math.max(windowMs, span);

    const resetFields: CaptureCounterName[] = [];
    for (const field of CAPTURE_COUNTER_FIELDS) {
      const before = start.counters[field];
      const after = end.counters[field];
      if (before === undefined || after === undefined) {
        continue;
      }
      if (after < before) {
        resetFields.push(field);
        continue;
      }
      deltas[field] = (deltas[field] ?? 0) + (after - before);
    }
    if (resetFields.length > 0) {
      resets.push({ node: nodeLabel(node), counters: resetFields });
    }
  }

  let coverage: CaptureCounterDeltas['coverage'] = 'complete';
  if (measured === 0) {
    coverage = 'unavailable';
  } else if (measured < nodes.length || resets.length > 0) {
    coverage = 'partial';
  }

  return {
    coverage,
    nodesTotal: nodes.length,
    nodesMeasured: measured,
    windowMs,
    deltas,
    resets,
    derived: deriveCounterRates(deltas, windowMs),
  };
}
