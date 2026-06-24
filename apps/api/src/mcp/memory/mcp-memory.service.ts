import { Injectable } from '@nestjs/common';
import {
  MemoryStore,
  type MemoryStoreClient,
  type MemoryListOptions,
  type MemoryListResult,
  type MemoryItem,
  type MemoryStats,
  type RecallOptions,
  type MemoryHit,
} from '@betterdb/agent-memory';
import { ConnectionRegistry } from '../../connections/connection-registry.service';

const REGISTRY_KEY = '__betterdb:caches';
const AGENT_MEMORY_TYPE = 'agent_memory';

export interface MemoryStoreInfo {
  name: string;
  prefix: string;
  statsKey: string;
  version: string;
  capabilities: string[];
}

interface AgentMemoryMarker {
  type: string;
  prefix: string;
  version: string;
  stats_key: string;
  capabilities?: string[];
}

@Injectable()
export class McpMemoryService {
  constructor(private readonly registry: ConnectionRegistry) {}

  private rawClient(id: string): MemoryStoreClient {
    return this.registry.get(id).getClient() as unknown as MemoryStoreClient;
  }

  buildStore(id: string, name: string): MemoryStore {
    return new MemoryStore({ client: this.rawClient(id), name });
  }

  async list(id: string, name: string, options: MemoryListOptions): Promise<MemoryListResult> {
    return this.buildStore(id, name).list(options);
  }

  async get(id: string, name: string, memoryId: string): Promise<MemoryItem | null> {
    return this.buildStore(id, name).get(memoryId);
  }

  async stats(id: string, name: string): Promise<MemoryStats> {
    return this.buildStore(id, name).stats();
  }

  async recall(
    id: string,
    name: string,
    vector: number[],
    options: RecallOptions,
  ): Promise<MemoryHit[]> {
    return this.buildStore(id, name).recallByVector(vector, { ...options, reinforce: false });
  }

  async discoverStores(id: string): Promise<MemoryStoreInfo[]> {
    const raw = await this.rawClient(id).call('HGETALL', REGISTRY_KEY);
    const fields = parseHashReply(raw);
    const stores: MemoryStoreInfo[] = [];
    for (const value of Object.values(fields)) {
      const marker = safeParseMarker(value);
      if (marker === null || marker.type !== AGENT_MEMORY_TYPE) {
        continue;
      }
      stores.push({
        name: marker.prefix,
        prefix: marker.prefix,
        statsKey: marker.stats_key,
        version: marker.version,
        capabilities: marker.capabilities ?? [],
      });
    }
    return stores;
  }
}

function safeParseMarker(value: string): AgentMemoryMarker | null {
  try {
    const parsed = JSON.parse(value) as Partial<AgentMemoryMarker>;
    if (typeof parsed.prefix !== 'string' || typeof parsed.type !== 'string') {
      return null;
    }
    return parsed as AgentMemoryMarker;
  } catch {
    return null;
  }
}

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
