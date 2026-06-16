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
  similarity: number;
  score: number;
}
