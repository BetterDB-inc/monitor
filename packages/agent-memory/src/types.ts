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
  ttl?: number;
}

export interface MemoryItem extends MemoryScope {
  id: string;
  content: string;
  importance: number;
  tags: string[];
  source?: string;
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
