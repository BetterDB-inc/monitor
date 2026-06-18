# @betterdb/agent-cache examples

Runnable examples for every adapter and major feature.

## Examples

| Directory | Description |
|---|---|
| [openai](./openai/) | OpenAI Chat Completions — text, vision (content-addressed image bytes), and tool-call caching via prepareParams |
| [anthropic](./anthropic/) | Anthropic Messages API — text, vision, and tool-call caching via storeMultipart |
| [llamaindex](./llamaindex/) | LlamaIndex OpenAI adapter — text + vision caching |
| [langchain](./langchain/) | BetterDBLlmCache wired into ChatOpenAI, plus tool caching and stats |
| [langgraph](./langgraph/) | BetterDBSaver checkpointer for graph state, plus LLM + tool caching |
| [vercel-ai-sdk](./vercel-ai-sdk/) | createAgentCacheMiddleware with wrapLanguageModel, plus tool caching |
| [monitor-proposals](./monitor-proposals/) | Live cache_propose_tool_ttl_adjust loop — no-restart TTL policy update |

## Running an example

Unlike semantic-cache, agent-cache needs **no modules** — it runs on vanilla
Valkey 7+ (or Redis 6.2+). The default connection is `localhost:6379`.

```bash
# Start Valkey locally (no modules required)
docker run -d --name valkey -p 6379:6379 valkey/valkey:8

cd examples/<name>
npm install
npm start
```

Standalone host/port can be overridden per example; the `openai`, `anthropic`,
and `llamaindex` examples also support Valkey Cluster via `VALKEY_CLUSTER` /
`VALKEY_CLUSTER_NODES`, and `monitor-proposals` reads `VALKEY_HOST` /
`VALKEY_PORT`.

## No API key examples

This example runs without any API keys — it writes directly to Valkey to
simulate the Monitor configuration loop:
- `monitor-proposals`

## Examples requiring API keys

- `openai`, `llamaindex`, `langchain`, `langgraph`, `vercel-ai-sdk`: require `OPENAI_API_KEY`
- `anthropic`: requires `ANTHROPIC_API_KEY`
