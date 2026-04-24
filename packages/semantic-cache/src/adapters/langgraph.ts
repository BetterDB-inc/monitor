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
  return namespaceKey(namespace).replace(/[^a-zA-Z0-9_-]/g, '_');
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
   * Uses FT.SEARCH with category and key metadata filter to locate the entry.
   */
  async get(namespace: string[], key: string): Promise<Item | null> {
    const category = namespaceToCategory(namespace);
    // Use invalidate-style FT.SEARCH with filter
    try {
      const result = await (this.cache as unknown as {
        client: {
          call: (...args: string[]) => Promise<unknown>;
        };
        indexName: string;
      }).client.call(
        'FT.SEARCH',
        (this.cache as unknown as { indexName: string }).indexName,
        `@category:{${category}}`,
        'LIMIT', '0', '100',
        'DIALECT', '2',
      );

      // Parse response manually since we need access to cache internals
      if (!Array.isArray(result) || result.length < 1) return null;

      const total = parseInt(String(result[0]), 10);
      if (!total) return null;

      for (let i = 1; i < (result as unknown[]).length; i += 2) {
        const fieldList = (result as unknown[])[i + 1];
        if (!Array.isArray(fieldList)) continue;

        const fields: Record<string, string> = {};
        for (let j = 0; j < fieldList.length - 1; j += 2) {
          fields[String(fieldList[j])] = String(fieldList[j + 1]);
        }

        const responseStr = fields['response'];
        if (!responseStr) continue;

        try {
          const item = JSON.parse(responseStr) as Item;
          if (item.key === key) {
            return item;
          }
        } catch { /* skip corrupt */ }
      }
    } catch { /* return null on error */ }

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
      // Direct KNN FT.SEARCH so we retrieve up to `limit` results, not just 1.
      // checkBatch([query], { k: limit }) passes limit as top-k to the search but
      // only returns one CacheCheckResult per prompt — so we bypass it here.
      const cacheInternals = this.cache as unknown as {
        client: { call: (...args: unknown[]) => Promise<unknown> };
        indexName: string;
        embed: (text: string) => Promise<{ vector: number[]; durationSec: number }>;
        defaultThreshold: number;
      };
      const { encodeFloat32, parseFtSearchResponse } = await import('../utils');
      const threshold = options?.threshold ?? cacheInternals.defaultThreshold;
      const { vector } = await cacheInternals.embed(query);
      const filterExpr = `(@category:{${category}})`;
      const knnQuery = `${filterExpr}=>[KNN ${limit} @embedding $vec AS __score]`;

      let raw: unknown;
      try {
        raw = await cacheInternals.client.call(
          'FT.SEARCH', cacheInternals.indexName, knnQuery,
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

    // No query - return all entries in namespace (non-semantic scan)
    try {
      const result = await (this.cache as unknown as {
        client: { call: (...args: string[]) => Promise<unknown> };
        indexName: string;
      }).client.call(
        'FT.SEARCH',
        (this.cache as unknown as { indexName: string }).indexName,
        `@category:{${category}}`,
        'LIMIT', '0', String(limit),
        'DIALECT', '2',
      );

      if (!Array.isArray(result) || result.length < 1) return [];

      const items: Item[] = [];
      for (let i = 1; i < (result as unknown[]).length; i += 2) {
        const fieldList = (result as unknown[])[i + 1];
        if (!Array.isArray(fieldList)) continue;

        const fields: Record<string, string> = {};
        for (let j = 0; j < fieldList.length - 1; j += 2) {
          fields[String(fieldList[j])] = String(fieldList[j + 1]);
        }

        const responseStr = fields['response'];
        if (responseStr) {
          try {
            items.push(JSON.parse(responseStr) as Item);
          } catch { /* skip */ }
        }
      }
      return items;
    } catch {
      return [];
    }
  }

  /**
   * Delete the specific entry at namespace/key.
   * Scans the namespace category and deletes only the Valkey key whose stored JSON
   * response matches the given key, leaving other entries in the namespace intact.
   */
  async delete(namespace: string[], key: string): Promise<void> {
    const category = namespaceToCategory(namespace);
    const cacheInternals = this.cache as unknown as {
      client: { call: (...args: unknown[]) => Promise<unknown>; del: (...keys: string[]) => Promise<unknown> };
      indexName: string;
    };
    const { parseFtSearchResponse } = await import('../utils');

    let raw: unknown;
    try {
      raw = await cacheInternals.client.call(
        'FT.SEARCH', cacheInternals.indexName,
        `@category:{${category}}`,
        'LIMIT', '0', '1000',
        'DIALECT', '2',
      );
    } catch {
      return;
    }

    for (const entry of parseFtSearchResponse(raw)) {
      const responseStr = entry.fields['response'];
      if (!responseStr) continue;
      try {
        const item = JSON.parse(responseStr) as { key?: string };
        if (item.key === key) {
          await cacheInternals.client.del(entry.key).catch(() => { /* best effort */ });
        }
      } catch { /* skip corrupt entries */ }
    }
  }

  /**
   * Batch put multiple items.
   */
  async batch(
    writes: Array<{ namespace: string[]; key: string; value: Record<string, unknown> | null }>,
  ): Promise<void> {
    await Promise.all(
      writes.map((w) =>
        w.value === null
          ? this.delete(w.namespace, w.key)
          : this.put(w.namespace, w.key, w.value),
      ),
    );
  }
}
