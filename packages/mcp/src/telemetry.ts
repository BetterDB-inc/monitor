interface TelemetryEvent {
  toolName: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
  error?: string;
}

type ApiRequestFn = (method: string, path: string, body?: unknown) => Promise<unknown>;

const FLUSH_INTERVAL_MS = 30_000;
const MAX_BUFFER_SIZE = 50;

let buffer: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let apiRequestFn: ApiRequestFn | null = null;
let disabled = false;

function flush(): Promise<void> {
  if (buffer.length === 0 || !apiRequestFn) return Promise.resolve();
  const events = buffer;
  buffer = [];
  return apiRequestFn('POST', '/mcp/telemetry', { events })
    .then(() => {})
    .catch(() => {
      // swallow — telemetry must never break the MCP server
    });
}

export function initTelemetry(apiFn: ApiRequestFn): void {
  if (process.env.BETTERDB_TELEMETRY === 'false') {
    disabled = true;
    return;
  }
  apiRequestFn = apiFn;
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

export function trackToolCall(event: Omit<TelemetryEvent, 'timestamp'>): void {
  if (disabled) return;
  buffer.push({ ...event, timestamp: Date.now() });
  if (buffer.length >= MAX_BUFFER_SIZE) {
    flush();
  }
}

export async function stopTelemetry(): Promise<void> {
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flush();
}
