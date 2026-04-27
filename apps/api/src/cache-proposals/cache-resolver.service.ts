import { Injectable, Logger } from '@nestjs/common';
import type { CacheType } from '@betterdb/shared';
import { REGISTRY_KEY, heartbeatKeyFor, AGENT_CACHE, SEMANTIC_CACHE } from '@betterdb/shared';
import { ConnectionRegistry } from '../connections/connection-registry.service';

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_NEGATIVE_TTL_MS = 2_000;

export interface ResolvedCache {
  name: string;
  type: CacheType;
  prefix: string;
  capabilities: string[];
  protocol_version: number;
  live: boolean;
}

interface CacheEntry {
  resolved: ResolvedCache | null;
  fetchedAt: number;
}

interface MarkerJson {
  type?: string;
  prefix?: string;
  capabilities?: unknown;
  protocol_version?: number;
}

@Injectable()
export class CacheResolverService {
  private readonly logger = new Logger(CacheResolverService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private ttlMs = DEFAULT_TTL_MS;
  private negativeTtlMs = DEFAULT_NEGATIVE_TTL_MS;
  private now: () => number = Date.now;

  constructor(private readonly registry: ConnectionRegistry) {}

  configureForTesting(options: {
    ttlMs?: number;
    negativeTtlMs?: number;
    now?: () => number;
  }): void {
    if (options.ttlMs !== undefined) {
      this.ttlMs = options.ttlMs;
    }
    if (options.negativeTtlMs !== undefined) {
      this.negativeTtlMs = options.negativeTtlMs;
    }
    if (options.now !== undefined) {
      this.now = options.now;
    }
  }

  async resolveCacheByName(connectionId: string, name: string): Promise<ResolvedCache | null> {
    const key = `${connectionId}:${name}`;
    const cached = this.cache.get(key);
    const ts = this.now();
    if (cached !== undefined) {
      const ttl = cached.resolved === null ? this.negativeTtlMs : this.ttlMs;
      if (ts - cached.fetchedAt < ttl) {
        return cached.resolved;
      }
    }

    const resolved = await this.fetchFromRegistry(connectionId, name);
    this.cache.set(key, { resolved, fetchedAt: ts });
    return resolved;
  }

  invalidate(connectionId: string, name?: string): void {
    if (name === undefined) {
      const prefix = `${connectionId}:`;
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) {
          this.cache.delete(key);
        }
      }
      return;
    }
    this.cache.delete(`${connectionId}:${name}`);
  }

  private async fetchFromRegistry(
    connectionId: string,
    name: string,
  ): Promise<ResolvedCache | null> {
    const adapter = this.registry.get(connectionId);
    const client = adapter.getClient();

    const raw = await client.hget(REGISTRY_KEY, name);
    if (raw === null) {
      return null;
    }

    let parsed: MarkerJson;
    try {
      parsed = JSON.parse(raw) as MarkerJson;
    } catch (err) {
      this.logger.warn(
        `Discovery marker for '${name}' on connection '${connectionId}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    if (parsed.type !== AGENT_CACHE && parsed.type !== SEMANTIC_CACHE) {
      this.logger.warn(
        `Discovery marker for '${name}' has unknown type '${parsed.type}' — ignoring`,
      );
      return null;
    }
    if (typeof parsed.prefix !== 'string' || parsed.prefix.length === 0) {
      this.logger.warn(`Discovery marker for '${name}' is missing prefix — ignoring`);
      return null;
    }

    const capabilities = Array.isArray(parsed.capabilities)
      ? parsed.capabilities.filter((c): c is string => typeof c === 'string')
      : [];
    const protocolVersion =
      typeof parsed.protocol_version === 'number' ? parsed.protocol_version : 1;

    const heartbeat = await client.get(heartbeatKeyFor(name));
    const live = heartbeat !== null;

    return {
      name,
      type: parsed.type,
      prefix: parsed.prefix,
      capabilities,
      protocol_version: protocolVersion,
      live,
    };
  }
}
