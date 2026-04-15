import { BaseCache } from '@langchain/core/caches';
import type { Generation } from '@langchain/core/outputs';
import { AIMessage } from '@langchain/core/messages';
import type { AgentCache } from '../AgentCache';

export interface BetterDBLlmCacheOptions {
  /** A pre-configured AgentCache instance. */
  cache: AgentCache;
}

/** Try to extract a model name like "gpt-4o-mini" from LangChain's llm_string.
 *
 * LangChain serializes the key as: `_model:"chatModel",_type:"openai",model_name:"gpt-4o-mini",...`
 * (comma-separated key:JSON-value pairs, sorted alphabetically). Not pure JSON.
 */
function extractModelName(llmString: string): string {
  const match = llmString.match(/\bmodel_name:"([^"]+)"/);
  if (match) return match[1];
  // Fallback for plain JSON format (older LangChain versions)
  try {
    const parsed = JSON.parse(llmString);
    return parsed.model_name ?? parsed.model ?? llmString;
  } catch {
    return llmString;
  }
}

interface LangChainUsageMetadata {
  input_tokens?: number;
  output_tokens?: number;
}

interface ChatGenerationLike extends Generation {
  message?: { usage_metadata?: LangChainUsageMetadata };
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
      model: extractModelName(llm_string),
      messages: [{ role: 'user', content: prompt }],
    });

    if (!result.hit || !result.response) return null;

    // Return ChatGeneration-shaped objects with a proper AIMessage.
    // We cannot store/return full ChatGeneration class instances because
    // AIMessage does not survive JSON round-tripping. Instead we store
    // only the text and reconstruct the message on lookup.
    try {
      const parsed: Array<{ text?: string }> = JSON.parse(result.response);
      return parsed.map((g) => {
        const text = g.text ?? '';
        return { text, message: new AIMessage(text) } as Generation;
      });
    } catch {
      return [{ text: result.response, message: new AIMessage(result.response) } as Generation];
    }
  }

  async update(prompt: string, llm_string: string, return_val: Generation[]): Promise<void> {
    // Store only the text from each generation — class instances
    // (AIMessage, ChatGeneration) are not JSON-round-trip safe.
    const stripped = return_val.map((g) => ({ text: g.text }));
    const text = JSON.stringify(stripped);
    if (!text) return;

    // Extract token counts from the AIMessage's usage_metadata (set by @langchain/openai)
    const first = return_val[0] as ChatGenerationLike | undefined;
    const usage = first?.message?.usage_metadata;
    const tokens = usage?.input_tokens !== undefined && usage?.output_tokens !== undefined
      ? { input: usage.input_tokens, output: usage.output_tokens }
      : undefined;

    await this.cache.llm.store(
      { model: extractModelName(llm_string), messages: [{ role: 'user', content: prompt }] },
      text,
      tokens ? { tokens } : undefined,
    );
  }
}
