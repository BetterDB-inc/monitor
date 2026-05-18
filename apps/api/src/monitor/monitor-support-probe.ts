import { Injectable, Logger } from '@nestjs/common';
import type Valkey from 'iovalkey';
import { ConnectionRegistry } from '../connections/connection-registry.service';

export type MonitorSupportStatus = 'yes' | 'no' | 'unknown';

export interface MonitorSupportResult {
  status: MonitorSupportStatus;
  /** Epoch ms of the probe that produced this result. */
  checkedAt: number;
  /** Which layer produced the answer. */
  source: 'command-info' | 'live-monitor';
  /** Short human-readable explanation, e.g., error message or "COMMAND INFO returned nil". */
  detail?: string;
}

interface DatabasePortLike {
  call(command: string, args: string[]): Promise<unknown>;
  getClient(): Valkey;
}

/** How long the live MONITOR probe holds the dedicated connection in MONITOR mode. */
const LIVE_MONITOR_PROBE_MS = 100;

/**
 * Probes whether the MONITOR command is available on a connection and caches
 * the answer for the lifetime of the process.
 *
 * The probe is layered from least to most intrusive — each layer can return a
 * definitive 'yes' / 'no' (which short-circuits the cascade) or 'unknown'
 * (which escalates to the next layer). The cache stores only the final
 * verdict, so later calls never re-run any layer.
 *
 * Current layers:
 *  1. `COMMAND INFO MONITOR` — read-only, free. Resolves the common cases
 *     (standard Redis/Valkey, Memorystore Standard, Upstash REST).
 *  2. Live `MONITOR` on a dedicated connection — definitive but intrusive
 *     (on metered providers it can be billed). Runs only when layer 1 was
 *     inconclusive (e.g., Upstash direct-Redis, which rejects
 *     `COMMAND INFO <name>` with "wrong number of arguments"). The hold is
 *     just long enough for iovalkey to fully enter monitor mode before we
 *     disconnect — verdict is set by whether the server returns `+OK`.
 *
 * The cache is in-memory only and survives until the API process restarts or
 * `invalidate(connectionId)` is called (e.g., after a connection is removed).
 */
@Injectable()
export class MonitorSupportProbe {
  private readonly logger = new Logger(MonitorSupportProbe.name);
  private readonly cache = new Map<string, MonitorSupportResult>();

  constructor(private readonly connectionRegistry: ConnectionRegistry) {}

  async probe(connectionId: string): Promise<MonitorSupportResult> {
    const cached = this.cache.get(connectionId);
    if (cached) {
      return cached;
    }

    const result = await this.runProbe(connectionId);
    this.cache.set(connectionId, result);
    return result;
  }

  /**
   * Returns the cached probe result without triggering a probe. Used by the
   * preflight UI: we don't want to open the start-session modal to actually
   * issue MONITOR — the probe only fires when the user commits to starting a
   * session via {@link MonitorCaptureService.startSession}.
   */
  getCached(connectionId: string): MonitorSupportResult | undefined {
    return this.cache.get(connectionId);
  }

  invalidate(connectionId: string): void {
    this.cache.delete(connectionId);
  }

  private async runProbe(connectionId: string): Promise<MonitorSupportResult> {
    const client = this.connectionRegistry.get(connectionId) as unknown as DatabasePortLike;

    const cheap = await this.runCommandInfoLayer(client, connectionId);
    if (cheap.status !== 'unknown') {
      return cheap;
    }

    this.logger.debug(
      `COMMAND INFO MONITOR inconclusive for ${connectionId} (${cheap.detail ?? 'no detail'}); ` +
        `escalating to live MONITOR probe`,
    );
    return this.runLiveMonitorLayer(client, connectionId);
  }

  private async runCommandInfoLayer(
    client: DatabasePortLike,
    connectionId: string,
  ): Promise<MonitorSupportResult> {
    try {
      const raw = await client.call('COMMAND', ['INFO', 'MONITOR']);
      return interpretCommandInfo(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.debug(`COMMAND INFO MONITOR failed on ${connectionId}: ${detail}`);
      return { status: 'unknown', source: 'command-info', checkedAt: Date.now(), detail };
    }
  }

  private async runLiveMonitorLayer(
    client: DatabasePortLike,
    connectionId: string,
  ): Promise<MonitorSupportResult> {
    const valkey = client.getClient();
    let monitor: Awaited<ReturnType<Valkey['monitor']>> | undefined;

    try {
      monitor = await valkey.monitor();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.debug(`Live MONITOR probe rejected on ${connectionId}: ${detail}`);
      const status = valkey.status === 'ready' ? 'no' : 'unknown';
      return { status, source: 'live-monitor', checkedAt: Date.now(), detail };
    }

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, LIVE_MONITOR_PROBE_MS));
    } finally {
      try {
        monitor.disconnect();
      } catch {
        // Disconnect on an already-closed monitor connection is benign.
      }
    }

    return {
      status: 'yes',
      source: 'live-monitor',
      checkedAt: Date.now(),
      detail: `Live MONITOR ran for ${LIVE_MONITOR_PROBE_MS}ms without error`,
    };
  }
}

/**
 * `COMMAND INFO <name>` returns an array with one element per requested name.
 *  - Supported: that element is itself an array starting with the command name.
 *  - Unsupported/blocked: that element is nil (RESP `_` or null).
 * Anything else (empty top-level array, unexpected shape) we report as 'unknown'
 * so the cascade escalates to the live MONITOR probe.
 */
function interpretCommandInfo(raw: unknown): MonitorSupportResult {
  const checkedAt = Date.now();

  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      status: 'unknown',
      source: 'command-info',
      checkedAt,
      detail: 'COMMAND INFO returned empty result',
    };
  }

  const entry = raw[0];
  if (entry === null || entry === undefined) {
    return {
      status: 'no',
      source: 'command-info',
      checkedAt,
      detail: 'COMMAND INFO MONITOR returned nil',
    };
  }
  if (Array.isArray(entry) && entry.length > 0) {
    return { status: 'yes', source: 'command-info', checkedAt };
  }

  return {
    status: 'unknown',
    source: 'command-info',
    checkedAt,
    detail: 'COMMAND INFO returned unexpected shape',
  };
}
