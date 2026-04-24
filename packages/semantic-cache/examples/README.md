# @betterdb/semantic-cache examples

Runnable examples for every adapter and major feature.

## Examples

| Directory | Description |
|---|---|
| [basic](./basic/) | Core store/check/invalidate flow with Voyage AI embeddings |
| [openai](./openai/) | OpenAI Chat Completions with prepareSemanticParams and createOpenAIEmbed |
| [openai-responses](./openai-responses/) | OpenAI Responses API adapter |
| [anthropic](./anthropic/) | Anthropic Messages API with OpenAI embeddings |
| [llamaindex](./llamaindex/) | LlamaIndex ChatMessage array adapter |
| [langchain](./langchain/) | BetterDBSemanticCache wired into ChatOpenAI |
| [vercel-ai-sdk](./vercel-ai-sdk/) | createSemanticCacheMiddleware with wrapLanguageModel |
| [langgraph](./langgraph/) | BetterDBSemanticStore as a LangGraph memory store |
| [multimodal](./multimodal/) | ContentBlock[] with BinaryBlock - text + image caching |
| [cost-tracking](./cost-tracking/) | store() with tokens/model, check() reporting costSaved |
| [threshold-tuning](./threshold-tuning/) | thresholdEffectiveness() recommendations |
| [embedding-cache](./embedding-cache/) | Embedding cache on/off comparison |
| [batch-check](./batch-check/) | checkBatch() pipelined multi-prompt lookups |
| [rerank](./rerank/) | Rerank hook for top-k candidate selection |

## Running an example

Each example requires Valkey 8.0+ with `valkey-search` running. The default
connection is `localhost:6399` - override via `VALKEY_HOST` / `VALKEY_PORT` env vars.

```bash
cd examples/<name>
pnpm install
pnpm start
```

## No API key examples

These examples run without any API keys using a built-in mock embedder:
- `multimodal`
- `cost-tracking`
- `threshold-tuning`
- `embedding-cache`
- `batch-check`
- `rerank`
- `langgraph`

## Examples requiring API keys

- `openai`, `openai-responses`, `langchain`, `vercel-ai-sdk`: require `OPENAI_API_KEY`
- `anthropic`: requires `ANTHROPIC_API_KEY` + `OPENAI_API_KEY` (for embeddings)
- `llamaindex`: requires `OPENAI_API_KEY`
- `basic`: requires `VOYAGE_API_KEY` (or use `--mock` flag)
