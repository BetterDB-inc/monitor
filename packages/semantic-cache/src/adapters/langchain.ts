import { createHash } from 'node:crypto';
import { BaseCache } from '@langchain/core/caches';
import type { Generation } from '@langchain/core/outputs';
import { SemanticCache } from '../SemanticCache';
import type { CacheCheckOptions } from '../types';

export interface BetterDBSemanticCacheOptions {
  /** A pre-configured SemanticCache instance. */
  cache: SemanticCache;
  /**
   * When true, cache lookups and stores are scoped to the specific LLM
   * configuration (model, temperature, etc.). This prevents cross-model
   * cache pollution but reduces hit rates — a prompt cached against gpt-4o
   * will not hit against gpt-4o-mini even if the responses would be identical.
   *
   * The llm_string is hashed (SHA-256, first 16 hex chars) for use as a
   * Valkey TAG field. The hash is deterministic: same LLM config = same hash.
   *
   * Default: false.
   */
  filterByModel?: boolean;
}

export class BetterDBSemanticCache extends BaseCache {
  private cache: SemanticCache;
  private filterByModel: boolean;
  private initialized = false;

  constructor(opts: BetterDBSemanticCacheOptions) {
    super();
    this.cache = opts.cache;
    this.filterByModel = opts.filterByModel ?? false;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.cache.initialize();
      this.initialized = true;
    }
  }

  private modelHash(llm_string: string): string {
    // llm_string is a serialised LangChain LLM config — not human-readable.
    // Hash it to a stable, TAG-safe identifier.
    return createHash('sha256').update(llm_string).digest('hex').slice(0, 16);
  }

  async lookup(prompt: string, llm_string: string): Promise<Generation[] | null> {
    await this.ensureInitialized();
    const opts: CacheCheckOptions = {};
    if (this.filterByModel) {
      opts.filter = `@model:{${this.modelHash(llm_string)}}`;
    }
    const result = await this.cache.check(prompt, opts);
    if (!result.hit || !result.response) return null;
    return [{ text: result.response }];
  }

  async update(prompt: string, llm_string: string, return_val: Generation[]): Promise<void> {
    await this.ensureInitialized();
    const text = return_val.map((g) => g.text).join('');
    if (!text) return;
    await this.cache.store(prompt, text, {
      model: this.modelHash(llm_string),
    });
  }
}
