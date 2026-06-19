import { AgentCache, type AgentCacheOptions } from '@betterdb/agent-cache';
import {
  MemoryStore,
  type MemoryDiscoveryConfig,
  type MemoryConfigRefreshConfig,
} from './MemoryStore';
import type { RecallWeights } from './compositeScore';
import type { EmbedFn, MemoryStoreClient } from './types';

const DEFAULT_NAME = 'betterdb_ac';

export interface AgentMemoryConfig {
  defaultThreshold?: number;
  recall?: {
    weights?: RecallWeights;
    halfLifeSeconds?: number;
  };
  maxItemsPerScope?: number;
  discovery?: boolean | MemoryDiscoveryConfig;
  configRefresh?: boolean | MemoryConfigRefreshConfig;
}

export interface AgentMemoryOptions extends AgentCacheOptions {
  embedFn: EmbedFn;
  memory?: AgentMemoryConfig;
}

export class AgentMemory {
  readonly llm: AgentCache['llm'];
  readonly tool: AgentCache['tool'];
  readonly session: AgentCache['session'];
  readonly memory: MemoryStore;
  private readonly cache: AgentCache;

  constructor(options: AgentMemoryOptions) {
    if (typeof options.embedFn !== 'function') {
      throw new Error('AgentMemory requires an embedFn to back the memory tier');
    }

    // Resolve the name once and hand the same value to both tiers so their key
    // prefixes, discovery markers, and stats keys can never drift apart.
    const name = options.name ?? DEFAULT_NAME;
    this.cache = new AgentCache({ ...options, name });
    this.llm = this.cache.llm;
    this.tool = this.cache.tool;
    this.session = this.cache.session;

    const memory = options.memory ?? {};
    this.memory = new MemoryStore({
      client: options.client as unknown as MemoryStoreClient,
      name,
      embedFn: options.embedFn,
      defaultThreshold: memory.defaultThreshold,
      weights: memory.recall?.weights,
      halfLifeSeconds: memory.recall?.halfLifeSeconds,
      maxItemsPerScope: memory.maxItemsPerScope,
      // The facade is the batteries-included product: discover the memory tier
      // alongside the cache tiers by default, unless explicitly disabled.
      discovery: memory.discovery ?? true,
      configRefresh: memory.configRefresh,
      telemetry: options.telemetry?.registry ? { registry: options.telemetry.registry } : undefined,
    });
  }

  async initialize(): Promise<void> {
    // Surface a discovery name-collision from either tier: awaiting
    // ensureDiscoveryReady() is AgentCache's documented strict collision check,
    // and the memory tier already propagates, so the cache side isn't swallowed.
    await Promise.all([
      this.cache.ensureDiscoveryReady(),
      this.memory.ensureDiscoveryReady(),
    ]);
  }

  async close(): Promise<void> {
    // Tear down both tiers even if one fails, so timers and heartbeats can't leak.
    try {
      await this.memory.close();
    } finally {
      await this.cache.shutdown();
    }
  }
}
