import {
  CAPTURE_COUNTER_FIELDS,
  type CaptureCounterName,
  type CaptureCounterSample,
  type CaptureCounterSnapshots,
  type CaptureNodeCounterSnapshot,
} from '@betterdb/shared';

const KNOWN_COUNTERS: ReadonlySet<string> = new Set(CAPTURE_COUNTER_FIELDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}

export function encodeCounterSnapshots(value: CaptureCounterSnapshots | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function decodeSample(raw: unknown): CaptureCounterSample | null {
  if (isRecord(raw) === false || isRecord(raw.counters) === false) {
    return null;
  }
  if (typeof raw.capturedAt !== 'number' || Number.isFinite(raw.capturedAt) === false) {
    return null;
  }
  const counters: CaptureCounterSample['counters'] = {};
  for (const [name, value] of Object.entries(raw.counters as Record<string, unknown>)) {
    if (KNOWN_COUNTERS.has(name) && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      counters[name as CaptureCounterName] = value;
    }
  }
  const sample: CaptureCounterSample = { capturedAt: raw.capturedAt, counters };
  if (typeof raw.runId === 'string' && raw.runId !== '') sample.runId = raw.runId;
  if (typeof raw.uptimeSec === 'number' && Number.isFinite(raw.uptimeSec) && raw.uptimeSec >= 0) {
    sample.uptimeSec = raw.uptimeSec;
  }
  return sample;
}

/**
 * Decode `capture_sessions.counter_snapshots`. Accepts a JSON string
 * (SQLite / libSQL TEXT) or an already-parsed value (pg JSONB). Malformed rows
 * decode to undefined so one bad row can never break session reads; unknown
 * counter names are dropped.
 */
export function decodeCounterSnapshots(raw: unknown): CaptureCounterSnapshots | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (isRecord(value) === false || value.version !== 1 || Array.isArray(value.nodes) === false) {
    return undefined;
  }
  const nodes: CaptureNodeCounterSnapshot[] = [];
  for (const entry of value.nodes as unknown[]) {
    if (isRecord(entry) === false) {
      return undefined;
    }
    const node: CaptureNodeCounterSnapshot = {
      start: decodeSample(entry.start),
      end: decodeSample(entry.end),
    };
    if (typeof entry.nodeId === 'string') node.nodeId = entry.nodeId;
    if (typeof entry.address === 'string') node.address = entry.address;
    if (typeof entry.startError === 'string') node.startError = entry.startError;
    if (typeof entry.endError === 'string') node.endError = entry.endError;
    nodes.push(node);
  }
  return { version: 1, nodes };
}
