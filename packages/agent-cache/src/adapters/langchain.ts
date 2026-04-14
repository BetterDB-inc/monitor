import { BaseCache } from '@langchain/core/caches';
import type { Generation } from '@langchain/core/outputs';
import type { AgentCache } from '../AgentCache';

export interface BetterDBLlmCacheOptions {
  /** A pre-configured AgentCache instance. */
  cache: AgentCache;
}

export class BetterDBLlmCache extends BaseCache {
  private cache: AgentCache;

  constructor(opts: BetterDBLlmCacheOptions) {
    super();
    this.cache = opts.cache;
  }

  async lookup(prompt: string, llm_string: string): Promise<Generation[] | null> {
    // LangChain passes the full serialized prompt as `prompt`
    // and the model config string as `llm_string`.
    // Hash them together as a single LLM cache check.
    const result = await this.cache.llm.check({
      model: llm_string,
      messages: [{ role: 'user', content: prompt }],
    });

    if (!result.hit || !result.response) return null;

    try {
      return JSON.parse(result.response);
    } catch {
      return [{ text: result.response }];
    }
  }

  async update(prompt: string, llm_string: string, return_val: Generation[]): Promise<void> {
    const text = JSON.stringify(return_val);
    if (!text) return;

    await this.cache.llm.store(
      { model: llm_string, messages: [{ role: 'user', content: prompt }] },
      text,
    );
  }
}
