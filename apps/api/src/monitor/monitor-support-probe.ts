import { Injectable, Logger } from '@nestjs/common';
import { ConnectionRegistry } from '../connections/connection-registry.service';

export type MonitorSupportStatus = 'yes' | 'no' | 'unknown';

export interface MonitorSupportResult {
  status: MonitorSupportStatus;
  /** Epoch ms of the probe that produced this result. */
  checkedAt: number;
  /** Short human-readable explanation, e.g. error message or "COMMAND INFO returned nil". */
  detail?: string;
}

interface DatabasePortLike {
  call(command: string, args: string[]): Promise<unknown>;
}

/**
 * Probes whether the MONITOR command is available on a connection and caches
 * the answer for the lifetime of the process.
 *
 * Probe strategy: `COMMAND INFO MONITOR`. A server that supports MONITOR
 * returns a one-element array describing the command; a server that has
 * disabled it (Upstash REST tier, Memorystore Standard, etc.) returns either
 * an array containing nil, an empty array, or rejects the COMMAND call
 * altogether. We treat errors as 'unknown' rather than 'no' so we don't show
 * a scary banner just because a hardened provider blocks COMMAND inspection.
 *
 * The cache is in-memory only and survives until the API process restarts or
 * `invalidate(connectionId)` is called (e.g. after a connection is removed).
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

  invalidate(connectionId: string): void {
    this.cache.delete(connectionId);
  }

  private async runProbe(connectionId: string): Promise<MonitorSupportResult> {
    const client = this.connectionRegistry.get(connectionId) as unknown as DatabasePortLike;
    if (typeof client?.call !== 'function') {
      return {
        status: 'unknown',
        checkedAt: Date.now(),
        detail: 'Database client does not expose call(command, args)',
      };
    }

    try {
      const raw = await client.call('COMMAND', ['INFO', 'MONITOR']);
      return interpretCommandInfo(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.debug(`COMMAND INFO MONITOR failed on ${connectionId}: ${detail}`);
      return { status: 'unknown', checkedAt: Date.now(), detail };
    }
  }
}

/**
 * `COMMAND INFO <name>` returns an array with one element per requested name.
 *  - Supported: that element is itself an array starting with the command name.
 *  - Unsupported/blocked: that element is nil (RESP `_` or null).
 * Anything else (empty top-level array, unexpected shape) we report as 'unknown'.
 */
function interpretCommandInfo(raw: unknown): MonitorSupportResult {
  const checkedAt = Date.now();

  if (!Array.isArray(raw) || raw.length === 0) {
    return { status: 'unknown', checkedAt, detail: 'COMMAND INFO returned empty result' };
  }

  const entry = raw[0];
  if (entry === null || entry === undefined) {
    return { status: 'no', checkedAt, detail: 'COMMAND INFO MONITOR returned nil' };
  }
  if (Array.isArray(entry) && entry.length > 0) {
    return { status: 'yes', checkedAt };
  }

  return { status: 'unknown', checkedAt, detail: 'COMMAND INFO returned unexpected shape' };
}
