/**
 * LangGraph BaseStore adapter for @betterdb/semantic-cache.
 *
 * BetterDBSemanticStore implements the LangGraph BaseStore interface,
 * enabling similarity-based memory retrieval from a SemanticCache instance.
 *
 * When to use this vs @betterdb/agent-cache/langgraph:
 * - Use @betterdb/agent-cache/langgraph (BetterDBSaver) for exact-match checkpoint
 *   persistence - storing and retrieving agent state snapshots by checkpoint ID.
 * - Use BetterDBSemanticStore (this class) for similarity-based memory retrieval -
 *   finding the most semantically relevant past observations, documents, or facts
 *   for a given query.
 * They can coexist on the same Valkey instance with different key prefixes.
 *
 * Storage layout:
 *   {name}:entry:{uuid}  - HSET entry per item (via SemanticCache.store)
 *   namespace is stored as the 'category' tag on entries for filtered recall
 *
 * Limitations:
 * - get() uses a Valkey SCAN for the deterministic key and may be slow on large stores.
 *   For high-frequency get() patterns, prefer a dedicated hash store (agent-cache session tier).
 * - delete() uses invalidate() which is limited to 1000 entries per call and requires
 *   FT.SEARCH to find matching keys.
 */

import type { SemanticCache } from '../SemanticCache';
import { escapeTag } from '../utils';

// --- Minimal LangGraph BaseStore shims ---
// We define minimal interface shims that match the LangGraph BaseStore contract
// without importing @langchain/langgraph-checkpoint directly, so this adapter
// works even if that package is not installed.

/** A stored item in the semantic memory store. */
export interface Item {
  /** Dot-separated namespace path (e.g. ['user', 'alice', 'memories']). */
  namespace: string[];
  /** Unique key within the namespace. */
  key: string;
  /** The stored value. */
  value: Record<string, unknown>;
  /** Creation timestamp as ISO string. */
  createdAt: string;
  /** Last update timestamp as ISO string. */
  updatedAt: string;
}

/** Options for the search() method. */
export interface SearchOptions {
  /** Natural-language query for similarity search. */
  query?: string;
  /** Maximum number of results. Default: 10. */
  limit?: number;
  /** Similarity threshold override (cosine distance, 0-2). */
  threshold?: number;
}

export interface BetterDBSemanticStoreOptions {
  /**
   * A pre-configured SemanticCache instance.
   * The cache must be initialized before calling store methods.
   */
  cache: SemanticCache;
  /**
   * Field to embed from stored values when no explicit query is provided.
   * Default: 'content'. The value of this field (if a string) is used as
   * the embedding text when put() is called without an explicit embed field.
   */
  embedField?: string;
}

function namespaceKey(namespace: string[]): string {
  return namespace.join(':');
}

function namespaceToCategory(namespace: string[]): string {
  // Replace path separators (. and /) only, leaving : intact as the namespace-segment
  // separator. Matches the Python implementation for cross-language compatibility.
  return namespaceKey(namespace).replace(/[./]/g, '_');
}

/**
 * LangGraph-compatible semantic memory store backed by SemanticCache.
 *
 * Implements a subset of the LangGraph BaseStore interface sufficient for
 * use as an in-memory store with similarity recall.
 */
export class BetterDBSemanticStore {
  private readonly cache: SemanticCache;
  private readonly embedField: string;

  constructor(opts: BetterDBSemanticStoreOptions) {
    this.cache = opts.cache;
    this.embedField = opts.embedField ?? 'content';
  }

  /**
   * Store a value at namespace/key.
   * The embedField value (if present and a string) is used as the embedding text.
   * Falls back to JSON stringified value if embedField is absent.
   */
  async put(namespace: string[], key: string, value: Record<string, unknown>): Promise<void> {
    // Upsert: remove any existing entry for this key before writing so repeated
    // put() calls don't accumulate stale duplicates.
    await this.delete(namespace, key);

    const embedText =
      typeof value[this.embedField] === 'string'
        ? (value[this.embedField] as string)
        : JSON.stringify(value);

    const category = namespaceToCategory(namespace);
    const now = new Date().toISOString();
    const item: Item = {
      namespace,
      key,
      value,
      createdAt: now,
      updatedAt: now,
    };

    await this.cache.store(embedText, JSON.stringify(item), {
      category,
      metadata: { key, namespace: namespaceKey(namespace) },
    });
  }

  /**
   * Retrieve a value by exact namespace and key.
   * Paginates through all entries in the namespace using stable SORTBY ordering.
   */
  async get(namespace: string[], key: string): Promise<Item | null> {
    const category = namespaceToCategory(namespace);
    const catFilter = `@category:{${escapeTag(category)}}`;
    const { parseFtSearchResponse } = await import('../utils');
    const BATCH = 100;
    let offset = 0;

    while (true) {
      let raw: unknown;
      try {
        raw = await this.cache._searchEntries(catFilter, BATCH, offset);
      } catch {
        return null;
      }
      const entries = parseFtSearchResponse(raw);
      if (entries.length === 0) break;

      for (const entry of entries) {
        const responseStr = entry.fields['response'];
        if (!responseStr) continue;
        try {
          const item = JSON.parse(responseStr) as Item;
          if (item.key === key) return item;
        } catch { /* skip corrupt */ }
      }

      if (entries.length < BATCH) break;
      offset += BATCH;
    }
    return null;
  }

  /**
   * Search the namespace using similarity.
   * When query is provided, embeds it and returns the k most similar entries.
   * When query is absent, returns all entries in the namespace (up to limit).
   */
  async search(namespace: string[], options?: SearchOptions): Promise<Item[]> {
    const limit = options?.limit ?? 10;
    const query = options?.query;
    const category = namespaceToCategory(namespace);

    if (query) {
      const { encodeFloat32, parseFtSearchResponse } = await import('../utils');
      const threshold = options?.threshold ?? (this.cache as unknown as { defaultThreshold: number }).defaultThreshold;
      const { vector } = await this.cache._embedText(query);
      const filterExpr = `(@category:{${escapeTag(category)}})`;
      const knnQuery = `${filterExpr}=>[KNN ${limit} @embedding $vec AS __score]`;

      let raw: unknown;
      try {
        raw = await (this.cache as unknown as {
          client: { call: (...args: unknown[]) => Promise<unknown> };
          indexName: string;
        }).client.call(
          'FT.SEARCH',
          (this.cache as unknown as { indexName: string }).indexName,
          knnQuery,
          'PARAMS', '2', 'vec', encodeFloat32(vector),
          'LIMIT', '0', String(limit),
          'DIALECT', '2',
        );
      } catch {
        return [];
      }

      const items: Item[] = [];
      for (const entry of parseFtSearchResponse(raw)) {
        const scoreVal = parseFloat(entry.fields['__score'] ?? 'NaN');
        if (isNaN(scoreVal) || scoreVal > threshold) continue;
        const responseStr = entry.fields['response'];
        if (responseStr) {
          try { items.push(JSON.parse(responseStr) as Item); } catch { /* skip */ }
        }
      }
      return items;
    }

    // No query — return all entries in namespace (up to limit) using _searchEntries
    const { parseFtSearchResponse } = await import('../utils');
    try {
      const result = await this.cache._searchEntries(
        `@category:{${escapeTag(category)}}`, limit, 0,
      );
      const items: Item[] = [];
      for (const entry of parseFtSearchResponse(result)) {
        const responseStr = entry.fields['response'];
        if (responseStr) {
          try { items.push(JSON.parse(responseStr) as Item); } catch { /* skip */ }
        }
      }
      return items;
    } catch {
      return [];
    }
  }

  /**
   * Delete the specific entry at namespace/key.
   * Pages through the namespace using stable SORTBY ordering; adjusts the offset
   * for each deleted entry so no entries are skipped in large namespaces.
   */
  async delete(namespace: string[], key: string): Promise<void> {
    const category = namespaceToCategory(namespace);
    const catFilter = `@category:{${escapeTag(category)}}`;
    const client = (this.cache as unknown as {
      client: { del: (...keys: string[]) => Promise<unknown> };
    }).client;
    const { parseFtSearchResponse } = await import('../utils');
    const BATCH = 100;
    let offset = 0;

    while (true) {
      let raw: unknown;
      try {
        raw = await this.cache._searchEntries(catFilter, BATCH, offset);
      } catch {
        return;
      }
      const entries = parseFtSearchResponse(raw);
      if (entries.length === 0) break;

      let deletedCount = 0;
      for (const entry of entries) {
        const responseStr = entry.fields['response'];
        if (!responseStr) continue;
        try {
          const item = JSON.parse(responseStr) as { key?: string };
          if (item.key === key) {
            await client.del(entry.key).catch(() => { /* best effort */ });
            deletedCount++;
          }
        } catch { /* skip corrupt */ }
      }

      if (entries.length < BATCH) break;
      offset += BATCH - deletedCount;
    }
  }

  /**
   * Batch put/delete multiple items.
   * Executes sequentially to avoid races when the same (namespace, key) appears
   * more than once: concurrent delete+put pairs can interleave and leave duplicates.
   */
  async batch(
    writes: Array<{ namespace: string[]; key: string; value: Record<string, unknown> | null }>,
  ): Promise<void> {
    for (const w of writes) {
      if (w.value === null) {
        await this.delete(w.namespace, w.key);
      } else {
        await this.put(w.namespace, w.key, w.value);
      }
    }
  }
}
