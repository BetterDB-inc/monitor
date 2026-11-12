import type { MonitorTarget } from './monitor-target.js';

export interface TelemetryEvent {
  toolName: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
  error?: string;
}

type SendFn = (target: MonitorTarget, events: TelemetryEvent[]) => Promise<unknown>;

const FLUSH_INTERVAL_MS = 30_000;
const MAX_BUFFER_SIZE = 50;

const buffers = new Map<MonitorTarget, TelemetryEvent[]>();
const retired = new WeakSet<MonitorTarget>();
let flushTimer: ReturnType<typeof setInterval> | null = null;
let sendFn: SendFn | null = null;
let disabled = false;

export function flushTelemetry(target: MonitorTarget): Promise<void> {
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

export function initTelemetry(send: SendFn): void {
  if (
    isTelemetryDisabled(process.env.BETTERDB_TELEMETRY) ||
    isTelemetryDisabled(process.env.BETTERDB_MCP_TELEMETRY)
  ) {
    disabled = true;
    return;
  }
  sendFn = send;
  flushTimer = setInterval(flushAll, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

export function trackToolCall(target: MonitorTarget, event: Omit<TelemetryEvent, 'timestamp'>): void {
  if (disabled || retired.has(target)) return;
  const events = buffers.get(target) ?? [];
  events.push({ ...event, timestamp: Date.now() });
  buffers.set(target, events);
  if (events.length >= MAX_BUFFER_SIZE) {
    flushTelemetry(target);
  }
}

export function dropTelemetry(target: MonitorTarget): void {
  retired.add(target);
  buffers.delete(target);
}

export async function stopTelemetry(): Promise<void> {
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flushAll();
}
