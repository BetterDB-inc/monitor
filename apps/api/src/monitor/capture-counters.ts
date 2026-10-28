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

/** Pick `run_id` and `uptime_in_seconds` out of a parsed INFO `# Server` section, when present. */
export function extractProcessIdentity(
  info: Record<string, unknown>,
): Pick<CaptureCounterSample, 'runId' | 'uptimeSec'> {
  const server = info.server;
  const identity: Pick<CaptureCounterSample, 'runId' | 'uptimeSec'> = {};
  if (typeof server !== 'object' || server === null) {
    return identity;
  }
  const section = server as Record<string, unknown>;
  const runId = section.run_id;
  if (typeof runId === 'string' && runId.trim() !== '') {
    identity.runId = runId.trim();
  }
  const uptime = section.uptime_in_seconds;
  if (typeof uptime === 'string' && uptime.trim() !== '') {
    const value = Number(uptime);
    if (Number.isFinite(value) && value >= 0) {
      identity.uptimeSec = value;
    }
  }
  return identity;
}

/** Build a sample from a raw INFO reply. Reads `# Stats` counters plus `# Server` identity when present. */
export function sampleFromInfoText(infoText: string, capturedAt: number): CaptureCounterSample {
  const info = InfoParser.parse(infoText);
  return { capturedAt, counters: extractCaptureCounters(info), ...extractProcessIdentity(info) };
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

/** Slack for uptime_in_seconds (whole seconds, sampled independently of capturedAt). */
const UPTIME_SLACK_SEC = 2;

/**
 * True when the process behind a node restarted between its two samples:
 * run_id changed, or end uptime is lower than start uptime plus the elapsed capture time,
 * or (start uptime missing) lower at the end than the sampled window.
 */
function restartedBetween(start: CaptureCounterSample, end: CaptureCounterSample): boolean {
  if (start.runId !== undefined && end.runId !== undefined) {
    return start.runId !== end.runId;
  }
  if (end.uptimeSec === undefined) {
    return false;
  }
  if (start.uptimeSec !== undefined) {
    const elapsedSec = Math.max(0, (end.capturedAt - start.capturedAt) / 1000);
    return end.uptimeSec + UPTIME_SLACK_SEC < start.uptimeSec + elapsedSec;
  }
  return end.uptimeSec + UPTIME_SLACK_SEC < (end.capturedAt - start.capturedAt) / 1000;
}

/**
 * Turn stored start/end samples into per-counter deltas summed across nodes.
 *
 * - A node is measured only when it has both samples, end.capturedAt >= start.capturedAt,
 *   and it neither restarted nor reset its stats in between.
 * - Restart: run_id changed or uptime_in_seconds fell (see restartedBetween). Reset: any
 *   counter went backwards. CONFIG RESETSTAT zeroes every stat at once, so one decreasing
 *   counter excludes the whole node from every sum (and from the hit ratio), and the
 *   node is named in `resets`. A RESETSTAT whose counters all climb back past their start
 *   values is not observable from INFO and cannot be detected.
 * - A counter reported on both samples by some measured nodes but not all is summed over
 *   the nodes that report it, listed in `incompleteCounters`, and coverage drops to partial.
 * - The window includes the capture's own footprint on each node: the start INFO, the
 *   MONITOR connection's handshake (AUTH/HELLO, the client's ready-check INFO, SELECT and
 *   CLIENT SETNAME when configured) and MONITOR itself add a few commands and one
 *   connection. total_net_output_bytes is deliberately not tracked: the server counts the
 *   MONITOR stream it sends to the capture connection in it.
 */
export function computeCounterDeltas(
  snapshots: CaptureCounterSnapshots | undefined,
  pending?: CaptureCounterDeltas['pending'],
): CaptureCounterDeltas {
  const deltas = emptyDeltas();
  const nodes = snapshots?.nodes ?? [];
  const resets: CaptureCounterReset[] = [];
  const reportedBy = new Map<CaptureCounterName, number>();
  let windowMs: number | null = null;
  let measured = 0;
  let ratioHits = 0;
  let ratioMisses = 0;
  let ratioNodes = 0;

  for (const node of nodes) {
    const start = node.start;
    const end = node.end;
    if (start === null || end === null || end.capturedAt < start.capturedAt) {
      continue;
    }

    const backwards = CAPTURE_COUNTER_FIELDS.filter((field) => {
      const before = start.counters[field];
      const after = end.counters[field];
      return before !== undefined && after !== undefined && after < before;
    });
    if (restartedBetween(start, end)) {
      resets.push({ node: nodeLabel(node), reason: 'restart', counters: backwards });
      continue;
    }
    if (backwards.length > 0) {
      resets.push({ node: nodeLabel(node), reason: 'counter_reset', counters: backwards });
      continue;
    }

    measured += 1;
    const span = end.capturedAt - start.capturedAt;
    windowMs = windowMs === null ? span : Math.max(windowMs, span);

    for (const field of CAPTURE_COUNTER_FIELDS) {
      const before = start.counters[field];
      const after = end.counters[field];
      if (before === undefined || after === undefined) {
        continue;
      }
      deltas[field] = (deltas[field] ?? 0) + (after - before);
      reportedBy.set(field, (reportedBy.get(field) ?? 0) + 1);
    }

    const hitsBefore = start.counters.keyspace_hits;
    const hitsAfter = end.counters.keyspace_hits;
    const missesBefore = start.counters.keyspace_misses;
    const missesAfter = end.counters.keyspace_misses;
    if (
      hitsBefore !== undefined &&
      hitsAfter !== undefined &&
      missesBefore !== undefined &&
      missesAfter !== undefined
    ) {
      ratioHits += hitsAfter - hitsBefore;
      ratioMisses += missesAfter - missesBefore;
      ratioNodes += 1;
    }
  }

  const incompleteCounters = CAPTURE_COUNTER_FIELDS.filter((field) => {
    const count = reportedBy.get(field) ?? 0;
    return count > 0 && count < measured;
  });

  let coverage: CaptureCounterDeltas['coverage'] = 'complete';
  if (measured === 0) {
    coverage = 'unavailable';
  } else if (measured < nodes.length || incompleteCounters.length > 0) {
    coverage = 'partial';
  }

  const derived = deriveCounterRates(deltas, windowMs);
  derived.keyspaceHitRatio =
    ratioNodes > 0 && ratioHits + ratioMisses > 0 ? ratioHits / (ratioHits + ratioMisses) : null;

  const result: CaptureCounterDeltas = {
    coverage,
    nodesTotal: nodes.length,
    nodesMeasured: measured,
    windowMs,
    deltas,
    resets,
    incompleteCounters,
    derived,
  };
  if (pending !== undefined) {
    result.pending = pending;
  }
  return result;
}
