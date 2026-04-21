import type Valkey from 'iovalkey';
import type { Registry } from 'prom-client';
import type { ContentBlock } from './utils';

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
  /** Use bundled default cost table from LiteLLM. User costTable entries override defaults. Default: true. */
  useDefaultCostTable?: boolean;
  telemetry?: {
    tracerName?: string;
    metricsPrefix?: string;
    registry?: Registry;
  };
  analytics?: {
    /** PostHog API key. Overrides the build-time baked key if set. */
    apiKey?: string;
    /** PostHog host. Overrides the build-time baked host if set. */
    host?: string;
    /** Disable analytics. Also controlled by BETTERDB_TELEMETRY env var. */
    disabled?: boolean;
    /** Interval in ms for periodic stats snapshots. Default: 300_000 (5 min). 0 to disable. */
    statsIntervalMs?: number;
  };
}

// --- LLM tier ---

export interface LlmCacheMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  toolCallId?: string;
  name?: string;
}

export interface LlmCacheParams {
  model: string;
  messages: Array<{ role: string; content: unknown; toolCallId?: string; name?: string }>;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: Array<{ type: string; function: { name: string; [key: string]: unknown } }>;
  toolChoice?: unknown;
  seed?: number;
  stop?: string[];
  responseFormat?: unknown;
  reasoningEffort?: string;
  promptCacheKey?: string;
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
  contentBlocks?: ContentBlock[];
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
  costSavedMicros: number;
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
  costSavedMicros: number;
  perTool: Record<string, ToolStats>;
}

export type {
  ContentBlock,
  TextBlock,
  BinaryBlock,
  ToolCallBlock,
  ToolResultBlock,
  ReasoningBlock,
  BlockHints,
} from "./utils";
