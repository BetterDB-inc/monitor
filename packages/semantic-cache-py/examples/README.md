# betterdb-semantic-cache examples

Runnable examples for every adapter and major feature.

## Examples

| Directory | Description |
|---|---|
| [basic](./basic/) | Core store/check/invalidate flow (mock embedder mode) |
| [openai](./openai/) | OpenAI Chat Completions with prepare_semantic_params and create_openai_embed |
| [anthropic](./anthropic/) | Anthropic Messages API with OpenAI embeddings |
| [llamaindex](./llamaindex/) | LlamaIndex message array adapter |
| [langchain](./langchain/) | BetterDBSemanticCache wired into ChatOpenAI |
| [langgraph](./langgraph/) | BetterDBSemanticStore as a LangGraph memory store |
| [multimodal](./multimodal/) | ContentBlock[] with BinaryBlock — text + image caching |
| [cost_tracking](./cost_tracking/) | store() with tokens/model, check() reporting cost_saved |
| [threshold_tuning](./threshold_tuning/) | threshold_effectiveness() recommendations |
| [embedding_cache](./embedding_cache/) | Embedding cache on/off comparison |
| [batch_check](./batch_check/) | check_batch() pipelined multi-prompt lookups |
| [rerank](./rerank/) | Rerank hook for top-k candidate selection |
| [judge](./judge/) | LLM-as-judge adjudication of borderline hits (mock judge) |
| [monitor_proposals](./monitor_proposals/) | Live cache_propose_threshold_adjust loop — no-restart threshold update |

## Running an example

Each example requires Valkey 8.0+ with `valkey-search` running. Override the
connection via `VALKEY_HOST` / `VALKEY_PORT` env vars — the mock-embedder
examples default to `localhost:6379`, the adapter examples to `localhost:6399`.

```bash
# Start Valkey with the valkey-search module
docker run -d --name valkey -p 6379:6379 valkey/valkey:8 \
  --loadmodule /usr/lib/valkey/valkey-search.so

cd examples/<name>
pip install betterdb-semantic-cache  # plus the per-example extras below
export OPENAI_API_KEY=sk-...          # if the example needs a key
python main.py
```

Per-example install extras:

- `basic`, `multimodal`, `cost_tracking`, `threshold_tuning`, `embedding_cache`, `batch_check`, `rerank`, `judge`, `monitor_proposals`: `pip install betterdb-semantic-cache`
- `openai`, `anthropic` (embeddings): `pip install "betterdb-semantic-cache[openai]"`
- `anthropic`: `pip install "betterdb-semantic-cache[openai,anthropic]"`
- `llamaindex`: `pip install "betterdb-semantic-cache[openai,llamaindex]"`
- `langchain`: `pip install "betterdb-semantic-cache[openai,langchain]"`
- `langgraph`: `pip install "betterdb-semantic-cache[openai,langgraph]"`

## No API key examples

These examples run without any API keys using a built-in mock embedder:
- `basic`
- `multimodal`
- `cost_tracking`
- `threshold_tuning`
- `embedding_cache`
- `batch_check`
- `rerank`
- `judge`
- `monitor_proposals`

## Examples requiring API keys

- `openai`, `langchain`, `langgraph`, `llamaindex`: require `OPENAI_API_KEY`
- `anthropic`: requires `ANTHROPIC_API_KEY` + `OPENAI_API_KEY` (for embeddings)
