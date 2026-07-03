import type { RecallWeights } from './compositeScore';

export type EmbedFn = (text: string) => Promise<number[]>;

export interface MemoryStoreClient {
  call(command: string, ...args: (string | Buffer | number)[]): Promise<unknown>;
}

export interface MemoryScope {
  threadId?: string;
  agentId?: string;
  namespace?: string;
}

export interface RememberOptions extends MemoryScope {
  importance?: number;
  tags?: string[];
  source?: string;
  /**
   * Reconciliation key for fact memories (see {@link Fact.subject}). Persisted so
   * a later {@link ConsolidateFactsOptions} run can supersede or retract the
   * stored fact for this subject instead of writing a duplicate.
   */
  subject?: string;
  ttl?: number;
}

export interface MemoryItem extends MemoryScope {
  id: string;
  content: string;
  importance: number;
  tags: string[];
  source?: string;
  /** Reconciliation key, present on fact memories written by consolidateFacts. */
  subject?: string;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
}

export interface RecallOptions extends MemoryScope {
  k?: number;
  threshold?: number;
  tags?: string[];
  weights?: RecallWeights;
  reinforce?: boolean;
}

export interface MemoryHit {
  item: MemoryItem;
  /**
   * Raw KNN vector **distance** (cosine), not a similarity: lower means closer
   * (a perfect match approaches 0). Despite the field name, do not assume
   * higher is better — sort ascending if ranking by this alone. The composite
   * `score` (higher is better) is the field to rank recall results by.
   */
  similarity: number;
  /** Composite recall score (similarity + recency + importance); higher is better. */
  score: number;
}

export interface ConsolidateOptions extends MemoryScope {
  olderThanSeconds?: number;
  maxImportance?: number;
  summarize: (items: MemoryItem[]) => Promise<string>;
  deleteSources?: boolean;
  summaryImportance?: number;
  tags?: string[];
}

export interface ConsolidateResult {
  consolidated: number;
  created: string[];
  deleted: number;
}

/**
 * An atomic, durable fact distilled from one or more memories. `subject` is a
 * short normalized attribute key (e.g. "employer", "home_city") used to
 * reconcile restatements; `date` (if known) drives newer-wins resolution and is
 * preserved in the written memory's content. `tombstone: true` marks the subject
 * as retracted.
 */
export interface Fact {
  subject: string;
  statement: string;
  date?: string;
  tombstone?: boolean;
}

/**
 * Caller-provided LLM seam that distills a batch of source memories into atomic
 * facts. The library never bakes in a model — you supply the extraction (mirrors
 * the `summarize` seam on {@link ConsolidateOptions}).
 */
export type FactExtractor = (items: MemoryItem[]) => Promise<Fact[]>;

export interface ConsolidateFactsOptions extends MemoryScope {
  /** LLM seam that extracts atomic facts from the selected source memories. */
  extractFacts: FactExtractor;
  tags?: string[];
  /** Only consider source memories older than this many seconds. */
  olderThanSeconds?: number;
  /** Only consider source memories at or below this importance. */
  maxImportance?: number;
  /** Importance assigned to each written fact memory (overrides the store default). */
  factImportance?: number;
}

export interface ConsolidateFactsResult {
  /** Source memories examined. */
  candidates: number;
  /** Curated facts after reconciliation (the full set now materialized for the scope). */
  facts: number;
  /** Ids of the newly written fact memories (added or superseded subjects). */
  created: string[];
  /** Prior fact memories deleted because a run superseded or retracted their subject. */
  deleted: number;
}

export interface MemoryListOptions extends MemoryScope {
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface MemoryListResult {
  items: MemoryItem[];
  total: number;
}
