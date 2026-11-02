import { EventEmitter } from 'events';
import type Valkey from 'iovalkey';
import { withTimeout } from '../common/utils/with-timeout';
import { MonitorSource } from './capture-writer';
import { isRedactionEnabled, redactWriteCommandArgs } from './value-redactor';

/**
 * Wrap iovalkey's `MONITOR` mode in our {@link MonitorSource} contract.
 *
 * Opens a NEW dedicated connection in MONITOR mode (the original `client` stays
 * usable). Stop disconnects only the dedicated connection; the originating
 * client is untouched.
 *
 * This replicates iovalkey's `client.monitor()` (duplicate with `monitor: true`,
 * resolve on the `monitoring` event) rather than calling it, so we hold the
 * duplicate and can disconnect it when the open times out. The open is bounded
 * by `openTimeoutMs`: a node that never answers must not hang the caller.
 */
export const MONITOR_OPEN_TIMEOUT_MS = 10_000;

export async function createIovalkeyMonitorSource(
  client: Valkey,
  openTimeoutMs: number = MONITOR_OPEN_TIMEOUT_MS,
): Promise<MonitorSource> {
  const monitor = client.duplicate({ monitor: true, lazyConnect: false });
  let onOpenError: ((err: Error) => void) | undefined;
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        onOpenError = reject;
        monitor.once('monitoring', () => resolve());
        monitor.once('error', onOpenError);
      }),
      openTimeoutMs,
      `MONITOR open timed out after ${openTimeoutMs} ms`,
    );
  } catch (err) {
    // A late error from the abandoned connection must not become unhandled.
    monitor.on('error', () => undefined);
    try {
      monitor.disconnect();
    } catch {
      // Ignore — disconnect on an already-closed connection is benign.
    }
    throw err;
  } finally {
    // Runtime errors are handled by the listener below; drop the open-phase one.
    if (onOpenError) monitor.off('error', onOpenError);
  }

  const emitter = new EventEmitter();
  let stopped = false;

  const redactionEnabled = isRedactionEnabled();
  monitor.on('monitor', (time: string, args: string[], source: string, database: number) => {
    if (stopped) return;
    const finalArgs = redactionEnabled ? redactWriteCommandArgs(args) : args;
    emitter.emit('line', formatMonitorLine(time, finalArgs, source, database));
  });

  monitor.on('error', (err: Error) => {
    if (stopped) return;
    emitter.emit('error', err);
  });

  monitor.on('end', () => {
    if (stopped) return;
    emitter.emit('end');
  });

  return {
    on: (event, cb) => emitter.on(event, cb as (...args: unknown[]) => void),
    off: (event, cb) => emitter.off(event, cb as (...args: unknown[]) => void),
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        monitor.disconnect();
      } catch {
        // Ignore — disconnect on an already-closed connection is benign.
      }
    },
  };
}

/**
 * Format an iovalkey monitor event as a textual MONITOR line, matching the
 * `<time> [<db> <addr>] "<arg>" "<arg>" ...` shape that `valkey-cli MONITOR`
 * emits. Args are quoted and have backslashes / quotes escaped.
 */
function formatMonitorLine(
  time: string,
  args: string[],
  source: string,
  database: number,
): string {
  const quoted = args.map((a) => `"${escapeArg(String(a))}"`).join(' ');
  return `${time} [${database} ${source}] ${quoted}`;
}

function escapeArg(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
