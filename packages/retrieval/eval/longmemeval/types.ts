import type { RetrieverClient } from '../../src/index';

/** A single turn in a LongMemEval session. */
export interface LmeTurn {
  role: 'user' | 'assistant';
  content: string;
  has_answer?: boolean;
}

/** One session is an ordered list of turns. */
export type LmeSession = LmeTurn[];

/**
 * LongMemEval record shape (real dataset + bundled fixture).
 * See https://github.com/xiaowu0162/LongMemEval
 */
export interface LmeRecord {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date?: string;
  haystack_session_ids: string[];
  haystack_dates?: string[];
  haystack_sessions: LmeSession[];
  answer_session_ids: string[];
}

export type ChunkMode = 'session' | 'turn';

/**
 * EMBEDDER seam. `dims` MUST equal the length the `embed` function returns so
 * the schema's vector.dims matches (OpenAI text-embedding-3-small = 1536).
 */
export interface Embedder {
  name: string;
  dims: number;
  embed: (text: string) => Promise<number[]>;
  /** Persist any cache to disk (no-op for the mock). */
  flush?: () => Promise<void>;
}

/**
 * STORE seam. `client` is handed to the Retriever. `isReal` drives async
 * index-settling polling; mock stores are synchronous and exact.
 */
export interface Store {
  name: string;
  isReal: boolean;
  client: RetrieverClient;
  close: () => Promise<void>;
}

/** READER seam (Tier 2): generate an answer from retrieved context. */
export interface Reader {
  name: string;
  answer: (question: string, contexts: string[]) => Promise<string>;
}

/** JUDGE seam (Tier 2): grade a generated answer against gold. */
export interface Judge {
  name: string;
  grade: (question: string, gold: string, predicted: string) => Promise<boolean>;
}
