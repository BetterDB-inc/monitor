import { Injectable, Logger } from '@nestjs/common';
import {
  REGISTRY_KEY,
  heartbeatKeyFor,
  type AiInstance,
  type AiInstanceKind,
  type AiInstanceMarker,
} from '@betterdb/shared';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import type { DatabasePort } from '../common/interfaces/database-port.interface';

const KNOWN_KINDS: ReadonlySet<string> = new Set<AiInstanceKind>([
  'agent_cache',
  'semantic_cache',
  'agent_memory',
  'retrieval',
]);

/**
 * Reads the shared `__betterdb:caches` discovery registry from a Valkey
 * connection and returns the AI cache / memory / retrieval instances registered
 * by our libraries, enriched with heartbeat liveness.
 *
 * This generalizes the agent-memory-only reader in
 * mcp/memory/mcp-memory.service.ts to every instance kind.
 */
@Injectable()
export class DiscoveryReaderService {
  private readonly logger = new Logger(DiscoveryReaderService.name);

  constructor(private readonly registry: ConnectionRegistry) {}

  /** Discover all AI instances registered on the given connection. */
  async discover(connectionId?: string): Promise<AiInstance[]> {
    const client = this.registry.get(connectionId);
    return this.discoverWithClient(client);
  }

  /** Same as discover(), but against an explicit client (used by the poller). */
  async discoverWithClient(client: DatabasePort): Promise<AiInstance[]> {
    let fields: Record<string, string>;
    try {
      const raw = await client.call('HGETALL', [REGISTRY_KEY]);
      fields = parseHashReply(raw);
    } catch (err) {
      this.logger.warn(
        `Failed to read discovery registry: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }

    const instances: AiInstance[] = [];
    for (const [field, value] of Object.entries(fields)) {
      const marker = safeParseMarker(value);
      if (marker === null || !KNOWN_KINDS.has(marker.type)) {
        continue;
      }
      const heartbeat = await this.readHeartbeat(client, field);
      instances.push({
        field,
        kind: marker.type as AiInstanceKind,
        name: marker.prefix,
        version: marker.version,
        capabilities: marker.capabilities ?? [],
        statsKey: marker.stats_key,
        indexName: marker.index_name,
        startedAt: marker.started_at,
        hostname: marker.hostname,
        alive: heartbeat !== null,
        lastHeartbeat: heartbeat ?? undefined,
      });
    }
    return instances;
  }

  private async readHeartbeat(
    client: DatabasePort,
    field: string,
  ): Promise<string | null> {
    try {
      const raw = await client.call('GET', [heartbeatKeyFor(field)]);
      return raw === null || raw === undefined ? null : String(raw);
    } catch {
      // A missing/expired heartbeat just means "not alive"; don't fail discovery.
      return null;
    }
  }
}

function safeParseMarker(value: string): AiInstanceMarker | null {
  try {
    const parsed = JSON.parse(value) as Partial<AiInstanceMarker>;
    if (typeof parsed.prefix !== 'string' || typeof parsed.type !== 'string') {
      return null;
    }
    return parsed as AiInstanceMarker;
  } catch {
    return null;
  }
}

/** Parse an HGETALL reply, which may be a flat array or an object depending on the client. */
function parseHashReply(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      out[String(raw[i])] = String(raw[i + 1]);
    }
    return out;
  }
  if (raw !== null && typeof raw === 'object') {
    for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
      out[field] = String(value);
    }
  }
  return out;
}
