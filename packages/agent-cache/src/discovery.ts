import { hostname } from 'node:os';

import { AgentCacheUsageError } from './errors';
import type { Valkey } from './types';

export const PROTOCOL_VERSION = 1;

export const REGISTRY_KEY = '__betterdb:caches';
export const PROTOCOL_KEY = '__betterdb:protocol';
export const HEARTBEAT_KEY_PREFIX = '__betterdb:heartbeat:';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TTL_SECONDS = 60;

export const TOOL_POLICIES_LIMIT = 500;

export const CACHE_TYPE = 'agent_cache' as const;
export type CacheType = typeof CACHE_TYPE;

export interface DiscoveryOptions {
  enabled?: boolean;
  heartbeatIntervalMs?: number;
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
    capabilities: ['tool_ttl_adjust', 'invalidate_by_tool', 'tool_effectiveness'],
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
  buildMetadata: () => MarkerMetadata;
  heartbeatIntervalMs?: number;
  logger?: DiscoveryLogger;
  onWriteFailed?: () => void;
}

export class DiscoveryManager {
  private readonly client: Valkey;
  private readonly name: string;
  private readonly buildMetadata: () => MarkerMetadata;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatKey: string;
  private readonly logger: DiscoveryLogger;
  private readonly onWriteFailed: () => void;

  private heartbeatHandle: ReturnType<typeof setInterval> | null = null;

  constructor(deps: DiscoveryManagerDeps) {
    this.client = deps.client;
    this.name = deps.name;
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
    await this.safeCall(() => this.client.hset(REGISTRY_KEY, this.name, payload), 'HSET registry');
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
    if (parsed.type && parsed.type !== CACHE_TYPE) {
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
