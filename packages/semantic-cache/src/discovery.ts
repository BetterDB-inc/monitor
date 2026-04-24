import { hostname } from 'node:os';

import type { Valkey } from './types';
import { SemanticCacheUsageError } from './errors';

export const PROTOCOL_VERSION = 1;

export const REGISTRY_KEY = '__betterdb:caches';
export const PROTOCOL_KEY = '__betterdb:protocol';
export const HEARTBEAT_KEY_PREFIX = '__betterdb:heartbeat:';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TTL_SECONDS = 60;

export type CacheType = 'semantic_cache' | 'agent_cache';

export interface DiscoveryOptions {
  /** Set to false to skip all registry writes. Default: true. */
  enabled?: boolean;
  /** Heartbeat interval in ms. Default: 30000. Exposed mainly for tests. */
  heartbeatIntervalMs?: number;
  /** Include per-category thresholds in the published marker. Default: true. */
  includeCategories?: boolean;
}

export interface MarkerMetadata {
  type: CacheType;
  prefix: string;
  version: string;
  protocol_version: number;
  capabilities: string[];
  stats_key: string;
  started_at: string;
  pid?: number;
  hostname?: string;
  [extra: string]: unknown;
}

export interface BuildSemanticMetadataInput {
  name: string;
  version: string;
  defaultThreshold: number;
  categoryThresholds: Record<string, number>;
  uncertaintyBand: number;
  includeCategories: boolean;
}

export function buildSemanticMetadata(input: BuildSemanticMetadataInput): MarkerMetadata {
  const metadata: MarkerMetadata = {
    type: 'semantic_cache',
    prefix: input.name,
    version: input.version,
    protocol_version: PROTOCOL_VERSION,
    // threshold_adjust is intentionally omitted until SemanticCache.check()
    // re-reads the {name}:__config hash at runtime. See
    // docs/plans/specs/spec-semantic-cache-discovery-markers.md "Open questions".
    capabilities: ['invalidate', 'similarity_distribution'],
    index_name: `${input.name}:idx`,
    stats_key: `${input.name}:__stats`,
    config_key: `${input.name}:__config`,
    default_threshold: input.defaultThreshold,
    uncertainty_band: input.uncertaintyBand,
    started_at: new Date().toISOString(),
    pid: process.pid,
    hostname: hostname(),
  };
  if (input.includeCategories && Object.keys(input.categoryThresholds).length > 0) {
    metadata.category_thresholds = { ...input.categoryThresholds };
  }
  return metadata;
}

export interface DiscoveryLogger {
  warn: (msg: string) => void;
  debug: (msg: string) => void;
}

const noopLogger: DiscoveryLogger = {
  warn: () => {},
  debug: () => {},
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface DiscoveryManagerDeps {
  client: Valkey;
  name: string;
  metadata: MarkerMetadata;
  heartbeatIntervalMs?: number;
  logger?: DiscoveryLogger;
  /** Called each time a best-effort write fails (HGET/HSET/SET protocol/heartbeat). */
  onWriteFailed?: () => void;
}

/**
 * Implements the shared `__betterdb:*` discovery marker protocol for
 * semantic-cache. See docs/plans/specs/spec-semantic-cache-discovery-markers.md
 * for the full contract.
 *
 * Semantics:
 * - `register()` throws on name collision (different cache type already
 *   registered under this name). All other Valkey errors are logged and
 *   swallowed; discovery is advisory, never a hard failure for the cache.
 * - `stop({ deleteHeartbeat: true })` is called from both `flush()` (drops
 *   the cache) and `dispose()` (graceful shutdown). Neither touches the
 *   registry hash — Monitor retains history.
 */
export class DiscoveryManager {
  private readonly client: Valkey;
  private readonly name: string;
  private readonly metadata: MarkerMetadata;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatKey: string;
  private readonly logger: DiscoveryLogger;
  private readonly onWriteFailed: () => void;

  private heartbeatHandle: ReturnType<typeof setInterval> | null = null;

  constructor(deps: DiscoveryManagerDeps) {
    this.client = deps.client;
    this.name = deps.name;
    this.metadata = deps.metadata;
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatKey = `${HEARTBEAT_KEY_PREFIX}${deps.name}`;
    this.logger = deps.logger ?? noopLogger;
    this.onWriteFailed = deps.onWriteFailed ?? (() => {});
  }

  async register(): Promise<void> {
    const existingJson = await this.safeHget();
    if (existingJson !== null) {
      this.checkCollision(existingJson);
    }

    await this.safeCall(
      () => this.client.hset(REGISTRY_KEY, this.name, JSON.stringify(this.metadata)),
      'HSET registry',
    );
    await this.safeCall(
      () => this.client.set(PROTOCOL_KEY, String(PROTOCOL_VERSION), 'NX'),
      'SET protocol',
    );

    // Write the initial heartbeat synchronously so Monitor sees the cache as
    // alive immediately after register() returns, instead of waiting up to
    // heartbeatIntervalMs for the first scheduled tick.
    await this.tickHeartbeat();

    this.startHeartbeat();
  }

  async stop(opts: { deleteHeartbeat: boolean }): Promise<void> {
    if (this.heartbeatHandle) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
    if (!opts.deleteHeartbeat) {
      return;
    }
    try {
      await this.client.del(this.heartbeatKey);
    } catch (err) {
      this.logger.debug(`discovery: DEL heartbeat failed: ${errMsg(err)}`);
    }
  }

  /** Exposed for tests. Writes the heartbeat key with TTL. */
  async tickHeartbeat(): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.client.set(this.heartbeatKey, now, 'EX', HEARTBEAT_TTL_SECONDS);
    } catch (err) {
      this.logger.debug(`discovery: heartbeat SET failed: ${errMsg(err)}`);
      this.onWriteFailed();
    }
  }

  private startHeartbeat(): void {
    const handle = setInterval(() => {
      void this.tickHeartbeat();
    }, this.heartbeatIntervalMs);
    handle.unref?.();
    this.heartbeatHandle = handle;
  }

  private async safeHget(): Promise<string | null> {
    try {
      return await this.client.hget(REGISTRY_KEY, this.name);
    } catch (err) {
      this.logger.warn(`discovery: HGET registry failed: ${errMsg(err)}`);
      this.onWriteFailed();
      return null;
    }
  }

  private async safeCall(fn: () => Promise<unknown>, label: string): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(`discovery: ${label} failed: ${errMsg(err)}`);
      this.onWriteFailed();
    }
  }

  private checkCollision(existingJson: string): void {
    let parsed: Partial<MarkerMetadata>;
    try {
      parsed = JSON.parse(existingJson) as Partial<MarkerMetadata>;
    } catch {
      return;
    }
    if (parsed.type && parsed.type !== this.metadata.type) {
      throw new SemanticCacheUsageError(
        `cache name collision: '${this.name}' is already registered as type '${String(parsed.type)}' on this Valkey instance`,
      );
    }
    if (parsed.version && parsed.version !== this.metadata.version) {
      this.logger.warn(
        `discovery: overwriting marker for '${this.name}' (existing version ${String(parsed.version)}, this version ${this.metadata.version})`,
      );
    }
  }
}
