import { EventEmitter } from 'events';
import type Valkey from 'iovalkey';
import { MonitorSource } from './capture-writer';

/**
 * Wrap iovalkey's `MONITOR` mode in our {@link MonitorSource} contract.
 *
 * `client.monitor()` opens a NEW dedicated connection in MONITOR mode (the
 * original `client` stays usable). Stop disconnects only the dedicated
 * connection; the originating client is untouched.
 */
export async function createIovalkeyMonitorSource(client: Valkey): Promise<MonitorSource> {
  const monitor = await client.monitor();

  const emitter = new EventEmitter();
  let stopped = false;

  monitor.on('monitor', (time: string, args: string[], source: string, database: number) => {
    if (stopped) return;
    emitter.emit('line', formatMonitorLine(time, args, source, database));
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
