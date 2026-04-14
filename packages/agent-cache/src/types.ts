import type Valkey from 'iovalkey';
import type { Registry } from 'prom-client';

export type { Valkey };

// --- Constructor options ---

export interface ModelCost {
  inputPer1k: number;
  outputPer1k: number;
}

export interface TierDefaults {
  ttl?: number; // seconds
}

export interface AgentCacheOptions {
  /** iovalkey client instance. Required. Caller owns the connection lifecycle. */
  client: Valkey;
  /** Key prefix for all Valkey keys. Default: 'betterdb_ac'. */
  name?: string;
  /** Default TTL in seconds. Overridable per-tier and per-call. undefined = no expiry. */
  defaultTtl?: number;
  /** Per-tier TTL defaults. */
  tierDefaults?: {
    llm?: TierDefaults;
    tool?: TierDefaults;
    session?: TierDefaults;
  };
  /** Model pricing for cost savings tracking. Optional. */
  costTable?: Record<string, ModelCost>;
  telemetry?: {
    tracerName?: string;
    metricsPrefix?: string;
    registry?: Registry;
  };
}

// --- LLM tier ---

export interface LlmCacheParams {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: Array<{ type: string; function: { name: string; [key: string]: unknown } }>;
}

export interface LlmStoreOptions {
  ttl?: number;
  tokens?: { input: number; output: number };
}

export interface CacheResult {
  hit: boolean;
  response?: string;
  key?: string;
  tier: 'llm' | 'tool' | 'session';
}

export interface LlmCacheResult extends CacheResult {
  tier: 'llm';
}

// --- Tool tier ---

export interface ToolStoreOptions {
  ttl?: number;
  cost?: number; // dollar cost of the API call
}

export interface ToolPolicy {
  ttl: number;
}

export interface ToolCacheResult extends CacheResult {
  tier: 'tool';
  toolName: string;
}

// --- Session tier ---

// Session methods use simple string get/set, no result wrapper needed.

// --- Stats ---

export interface TierStats {
  hits: number;
  misses: number;
  total: number;
  hitRate: number;
}

export interface SessionStats {
  reads: number;
  writes: number;
}

export interface ToolStats {
  hits: number;
  misses: number;
  hitRate: number;
  ttl: number | undefined;
}

export type ToolRecommendation = 'increase_ttl' | 'optimal' | 'decrease_ttl_or_disable';

export interface ToolEffectivenessEntry {
  tool: string;
  hitRate: number;
  costSaved: number;
  recommendation: ToolRecommendation;
}

export interface AgentCacheStats {
  llm: TierStats;
  tool: TierStats;
  session: SessionStats;
  costSavedCents: number;
  perTool: Record<string, ToolStats>;
}
