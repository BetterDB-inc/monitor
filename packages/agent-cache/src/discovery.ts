import { hostname } from 'node:os';

import { AgentCacheUsageError } from './errors';
import type { Valkey } from './types';

export const PROTOCOL_VERSION = 1;

export const REGISTRY_KEY = '__betterdb:caches';
export const PROTOCOL_KEY = '__betterdb:protocol';
export const HEARTBEAT_KEY_PREFIX = '__betterdb:heartbeat:';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TTL_SECONDS = 60;

/** Cap on the number of tool names published in the marker to keep HSET cheap. */
export const TOOL_POLICIES_LIMIT = 500;

export type CacheType = 'semantic_cache' | 'agent_cache';

export interface DiscoveryOptions {
  /** Set to false to skip all registry writes. Default: true. */
  enabled?: boolean;
  /** Heartbeat interval in ms. Default: 30000. Exposed mainly for tests. */
  heartbeatIntervalMs?: number;
  /** Include `tool_policies` in the published marker. Default: true. */
  includeToolPolicies?: boolean;
}

export interface TierMarkerInfo {
  enabled: boolean;
  ttl_default?: number;
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

export interface BuildAgentMetadataInput {
  name: string;
  version: string;
  tiers: {
    llm?: { ttl?: number };
    tool?: { ttl?: number };
    session?: { ttl?: number };
  };
  defaultTtl: number | undefined;
  toolPolicyNames: string[];
  hasCostTable: boolean;
  usesDefaultCostTable: boolean;
  startedAt: string;
  includeToolPolicies: boolean;
}

export function buildAgentMetadata(input: BuildAgentMetadataInput): MarkerMetadata {
  const tierMarker = (ttl: number | undefined): TierMarkerInfo => ({
    enabled: true,
    ttl_default: ttl ?? input.defaultTtl,
  });

  const metadata: MarkerMetadata = {
    type: 'agent_cache',
    prefix: input.name,
    version: input.version,
    protocol_version: PROTOCOL_VERSION,
    capabilities: [
      'tool_ttl_adjust',
      'invalidate_by_tool',
      'tool_effectiveness',
    ],
    stats_key: `${input.name}:__stats`,
    tiers: {
      llm: tierMarker(input.tiers.llm?.ttl),
      tool: tierMarker(input.tiers.tool?.ttl),
      session: tierMarker(input.tiers.session?.ttl),
    },
    has_cost_table: input.hasCostTable,
    uses_default_cost_table: input.usesDefaultCostTable,
    started_at: input.startedAt,
    pid: process.pid,
    hostname: hostname(),
  };

  if (input.includeToolPolicies) {
    const names = input.toolPolicyNames;
    if (names.length > TOOL_POLICIES_LIMIT) {
      metadata.tool_policies = names.slice(0, TOOL_POLICIES_LIMIT);
      metadata.tool_policies_truncated = true;
    } else {
      metadata.tool_policies = [...names];
    }
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
  cacheType: CacheType;
  /** Snapshot of the marker metadata to publish. Called on register and on each heartbeat tick. */
  buildMetadata: () => MarkerMetadata;
  heartbeatIntervalMs?: number;
  logger?: DiscoveryLogger;
  /** Called each time a best-effort write fails (HGET/HSET/SET protocol/heartbeat). */
  onWriteFailed?: () => void;
}

/**
 * Implements the shared `__betterdb:*` discovery marker protocol for
 * agent-cache. See docs/plans/specs/spec-agent-cache-discovery-markers.md.
 *
 * Semantics:
 * - `register()` throws `AgentCacheUsageError` on name collision (different
 *   cache type already registered). All other Valkey errors are logged and
 *   swallowed; discovery is advisory, never a hard failure for the cache.
 * - Heartbeat ticks refresh the registry metadata (so `tool_policies`
 *   discovered via `setPolicy` becomes visible within 30s) and re-write the
 *   protocol NX key as belt-and-braces against LRU eviction.
 * - `stop({ deleteHeartbeat: true })` is called from `shutdown()` and
 *   removes the heartbeat key but leaves the registry entry intact.
 */
export class DiscoveryManager {
  private readonly client: Valkey;
  private readonly name: string;
  private readonly cacheType: CacheType;
  private readonly buildMetadata: () => MarkerMetadata;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatKey: string;
  private readonly logger: DiscoveryLogger;
  private readonly onWriteFailed: () => void;

  private heartbeatHandle: ReturnType<typeof setInterval> | null = null;

  constructor(deps: DiscoveryManagerDeps) {
    this.client = deps.client;
    this.name = deps.name;
    this.cacheType = deps.cacheType;
    this.buildMetadata = deps.buildMetadata;
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

    await this.writeMetadata();
    await this.safeCall(
      () => this.client.set(PROTOCOL_KEY, String(PROTOCOL_VERSION), 'NX'),
      'SET protocol',
    );

    // Write the initial heartbeat synchronously so Monitor sees the cache as
    // alive immediately after register() returns, instead of waiting up to
    // heartbeatIntervalMs for the first scheduled tick.
    await this.writeHeartbeat();

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

  /** Exposed for tests. Writes heartbeat, refreshes metadata, re-asserts the protocol NX. */
  async tickHeartbeat(): Promise<void> {
    await this.writeHeartbeat();
    await this.writeMetadata();
    await this.safeCall(
      () => this.client.set(PROTOCOL_KEY, String(PROTOCOL_VERSION), 'NX'),
      'SET protocol (heartbeat)',
    );
  }

  private startHeartbeat(): void {
    const handle = setInterval(() => {
      void this.tickHeartbeat();
    }, this.heartbeatIntervalMs);
    handle.unref?.();
    this.heartbeatHandle = handle;
  }

  private async writeHeartbeat(): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.client.set(this.heartbeatKey, now, 'EX', HEARTBEAT_TTL_SECONDS);
    } catch (err) {
      this.logger.debug(`discovery: heartbeat SET failed: ${errMsg(err)}`);
      this.onWriteFailed();
    }
  }

  private async writeMetadata(): Promise<void> {
    let payload: string;
    try {
      payload = JSON.stringify(this.buildMetadata());
    } catch (err) {
      this.logger.warn(`discovery: metadata serialise failed: ${errMsg(err)}`);
      this.onWriteFailed();
      return;
    }
    await this.safeCall(
      () => this.client.hset(REGISTRY_KEY, this.name, payload),
      'HSET registry',
    );
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
    if (parsed.type && parsed.type !== this.cacheType) {
      throw new AgentCacheUsageError(
        `cache name collision: '${this.name}' is already registered as type '${String(parsed.type)}' on this Valkey instance`,
      );
    }
    const newMeta = this.buildMetadata();
    if (parsed.version && parsed.version !== newMeta.version) {
      this.logger.warn(
        `discovery: overwriting marker for '${this.name}' (existing version ${String(parsed.version)}, this version ${newMeta.version})`,
      );
    }
  }
}
