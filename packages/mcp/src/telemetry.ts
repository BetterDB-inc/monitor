export interface TelemetryEvent {
  toolName: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
  error?: string;
}

type SendFn<T> = (target: T, events: TelemetryEvent[]) => Promise<unknown>;

const FLUSH_INTERVAL_MS = 30_000;
const MAX_BUFFER_SIZE = 50;

const buffers = new Map<unknown, TelemetryEvent[]>();
let flushTimer: ReturnType<typeof setInterval> | null = null;
let sendFn: SendFn<unknown> | null = null;
let disabled = false;

export function flushTelemetry(target: unknown): Promise<void> {
  const events = buffers.get(target);
  buffers.delete(target);
  if (!events || events.length === 0 || !sendFn) return Promise.resolve();
  return sendFn(target, events)
    .then(() => {})
    .catch(() => {});
}

function flushAll(): Promise<void> {
  return Promise.all([...buffers.keys()].map(flushTelemetry)).then(() => {});
}

const OFF_VALUES = new Set(['false', '0', 'no', 'off']);

export function isTelemetryDisabled(value: string | undefined): boolean {
  return value !== undefined && OFF_VALUES.has(value.trim().toLowerCase());
}

export function initTelemetry<T>(send: SendFn<T>): void {
  if (isTelemetryDisabled(process.env.BETTERDB_TELEMETRY)) {
    disabled = true;
    return;
  }
  sendFn = send as SendFn<unknown>;
  flushTimer = setInterval(flushAll, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

export function trackToolCall(target: unknown, event: Omit<TelemetryEvent, 'timestamp'>): void {
  if (disabled) return;
  const events = buffers.get(target) ?? [];
  events.push({ ...event, timestamp: Date.now() });
  buffers.set(target, events);
  if (events.length >= MAX_BUFFER_SIZE) {
    flushTelemetry(target);
  }
}

export async function stopTelemetry(): Promise<void> {
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flushAll();
}
