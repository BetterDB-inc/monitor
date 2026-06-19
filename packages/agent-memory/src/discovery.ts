import { hostname } from 'node:os';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_KEY_PREFIX,
  HEARTBEAT_TTL_SECONDS,
  PROTOCOL_KEY,
  PROTOCOL_VERSION,
  REGISTRY_KEY,
} from '@betterdb/agent-cache';
import type { MemoryStoreClient } from './types';

export const MEMORY_CACHE_TYPE = 'agent_memory';
export const MEMORY_CAPABILITIES = ['recall', 'consolidate', 'reinforce'];

export interface MemoryMarker {
  type: typeof MEMORY_CACHE_TYPE;
  prefix: string;
  version: string;
  protocol_version: number;
  capabilities: string[];
  stats_key: string;
  started_at: string;
  pid?: number;
  hostname?: string;
}

export interface MemoryDiscoveryDeps {
  client: MemoryStoreClient;
  name: string;
  version: string;
  statsKey: string;
  heartbeatIntervalMs?: number;
  onWriteFailed?: () => void;
}

export class MemoryDiscovery {
  private readonly client: MemoryStoreClient;
  private readonly name: string;
  private readonly version: string;
  private readonly statsKey: string;
  private readonly heartbeatIntervalMs: number;
  private readonly markerField: string;
  private readonly heartbeatKey: string;
  private readonly startedAt: string;
  private readonly onWriteFailed: () => void;
  private heartbeatHandle: ReturnType<typeof setInterval> | null = null;
  private inFlightTick: Promise<void> | null = null;

  constructor(deps: MemoryDiscoveryDeps) {
    this.client = deps.client;
    this.name = deps.name;
    this.version = deps.version;
    this.statsKey = deps.statsKey;
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    // Namespace the marker under `{name}:mem` so a memory store and an
    // agent-cache sharing the same name register distinct registry fields and
    // heartbeat keys instead of clobbering each other.
    this.markerField = `${deps.name}:mem`;
    this.heartbeatKey = `${HEARTBEAT_KEY_PREFIX}${this.markerField}`;
    this.startedAt = new Date().toISOString();
    this.onWriteFailed = deps.onWriteFailed ?? (() => {});
  }

  buildMarker(): MemoryMarker {
    const marker: MemoryMarker = {
      type: MEMORY_CACHE_TYPE,
      prefix: this.name,
      version: this.version,
      protocol_version: PROTOCOL_VERSION,
      capabilities: [...MEMORY_CAPABILITIES],
      stats_key: this.statsKey,
      started_at: this.startedAt,
      pid: process.pid,
      hostname: hostname(),
    };
    return marker;
  }

  async register(): Promise<void> {
    // HGET-then-HSET is not atomic (TOCTOU); acceptable for best-effort
    // discovery — a racing writer just means last-writer-wins on the marker.
    const existing = await this.safeHget();
    if (existing !== null) {
      this.checkCollision(existing);
    }
    await this.writeMarker();
    await this.safeCall(() =>
      this.client.call('SET', PROTOCOL_KEY, String(PROTOCOL_VERSION), 'NX'),
    );
    await this.writeHeartbeat();
    this.startHeartbeat();
  }

  async stop(opts: { deleteHeartbeat: boolean }): Promise<void> {
    if (this.heartbeatHandle) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
    // Wait out a tick already in flight so its heartbeat/marker writes can't
    // land after the DEL below and make the store look alive post-shutdown.
    if (this.inFlightTick) {
      await this.inFlightTick;
    }
    if (!opts.deleteHeartbeat) {
      return;
    }
    try {
      await this.client.call('DEL', this.heartbeatKey);
    } catch {
      this.onWriteFailed();
    }
  }

  async tickHeartbeat(): Promise<void> {
    await this.writeHeartbeat();
    await this.writeMarker();
    // PROTOCOL_KEY is set once in register(); the NX SET is a guaranteed no-op
    // on every subsequent tick, so it's not re-issued from the heartbeat path.
  }

  private startHeartbeat(): void {
    const handle = setInterval(() => {
      this.inFlightTick = this.tickHeartbeat()
        .catch(() => undefined)
        .finally(() => {
          this.inFlightTick = null;
        });
    }, this.heartbeatIntervalMs);
    handle.unref?.();
    this.heartbeatHandle = handle;
  }

  private async writeHeartbeat(): Promise<void> {
    try {
      await this.client.call(
        'SET',
        this.heartbeatKey,
        new Date().toISOString(),
        'EX',
        String(HEARTBEAT_TTL_SECONDS),
      );
    } catch {
      this.onWriteFailed();
    }
  }

  private async writeMarker(): Promise<void> {
    let payload: string;
    try {
      payload = JSON.stringify(this.buildMarker());
    } catch {
      this.onWriteFailed();
      return;
    }
    await this.safeCall(() => this.client.call('HSET', REGISTRY_KEY, this.markerField, payload));
  }

  private async safeHget(): Promise<string | null> {
    try {
      const value = await this.client.call('HGET', REGISTRY_KEY, this.markerField);
      return value === null || value === undefined ? null : String(value);
    } catch {
      this.onWriteFailed();
      return null;
    }
  }

  private async safeCall(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch {
      this.onWriteFailed();
    }
  }

  private checkCollision(existingJson: string): void {
    let parsed: { type?: string };
    try {
      parsed = JSON.parse(existingJson) as { type?: string };
    } catch {
      return;
    }
    if (parsed.type && parsed.type !== MEMORY_CACHE_TYPE) {
      // Reachable only if a non-agent_memory marker already occupies this field.
      // The memory marker lives under `{name}:mem`, distinct from agent-cache's
      // `{name}`, so the two tiers never collide here. Surface it with a visible
      // warning rather than throwing into a swallowed registration promise;
      // registration then proceeds last-writer-wins, matching agent-cache.
      console.warn(
        `agent-memory discovery: field '${this.markerField}' already holds a '${parsed.type}' marker; overwriting`,
      );
    }
  }
}
