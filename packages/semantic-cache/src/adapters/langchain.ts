import { BaseCache } from '@langchain/core/caches';
import type { Generation } from '@langchain/core/outputs';
import { AIMessage } from '@langchain/core/messages';
import { SemanticCache } from '../SemanticCache';
import type { CacheCheckOptions } from '../types';
import { sha256 } from '../utils';

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
  private initPromise: Promise<void> | null = null;

  constructor(opts: BetterDBSemanticCacheOptions) {
    super();
    this.cache = opts.cache;
    this.filterByModel = opts.filterByModel ?? false;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.cache.initialize().catch((err) => {
        this.initPromise = null; // allow retry on transient failure
        throw err;
      });
    }
    await this.initPromise;
  }

  private modelHash(llm_string: string): string {
    // llm_string is a serialised LangChain LLM config — not human-readable.
    // Hash it to a stable, TAG-safe identifier.
    return sha256(llm_string).slice(0, 16);
  }

  async lookup(prompt: string, llm_string: string): Promise<Generation[] | null> {
    await this.ensureInitialized();
    const opts: CacheCheckOptions = {};
    if (this.filterByModel) {
      opts.filter = `@model:{${this.modelHash(llm_string)}}`;
    }
    const result = await this.cache.check(prompt, opts);
    if (!result.hit || !result.response) return null;
    // Return a ChatGeneration-shaped object with a proper AIMessage so that
    // ChatOpenAI and other chat models can unwrap it correctly on cache hit.
    // Plain { text } without a message causes "Cannot read properties of undefined"
    // when the model tries to access response.content.
    return [{ text: result.response, message: new AIMessage(result.response) } as Generation];
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
