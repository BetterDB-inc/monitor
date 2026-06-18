# betterdb-agent-cache examples

Runnable examples for every adapter and major feature.

## Examples

| Directory | Description |
|---|---|
| [openai](./openai/) | OpenAI Chat Completions — text, vision (content-addressed image bytes), and tool-call caching via prepare_params |
| [openai_responses](./openai_responses/) | OpenAI Responses API (beta) — text and function_call caching |
| [anthropic](./anthropic/) | Anthropic Messages API — text, vision, and tool-call caching via store_multipart |
| [llamaindex](./llamaindex/) | LlamaIndex OpenAI adapter — text + vision caching |
| [langchain](./langchain/) | BetterDBLlmCache wired into ChatOpenAI, plus tool result caching |
| [langgraph](./langgraph/) | BetterDBSaver checkpointer for graph state, plus LLM + tool caching |
| [monitor_proposals](./monitor_proposals/) | Live cache_propose_tool_ttl_adjust loop — no-restart TTL policy update |

## Running an example

Unlike semantic-cache, agent-cache needs **no modules** — it runs on vanilla
Valkey 7+ (or Redis 6.2+). The default connection is `localhost:6379`.

```bash
# Start Valkey locally (no modules required)
docker run -d --name valkey -p 6379:6379 valkey/valkey:8

cd examples/<name>
pip install betterdb-agent-cache  # plus the per-example extras below
export OPENAI_API_KEY=sk-...       # if the example needs a key
python main.py
```

Each example pins the exact install extras it needs in its module docstring:

- `openai`, `openai_responses`: `pip install "betterdb-agent-cache[openai]"`
- `anthropic`: `pip install "betterdb-agent-cache[anthropic]"`
- `llamaindex`: `pip install "betterdb-agent-cache[llamaindex]" llama-index-llms-openai`
- `langchain`: `pip install "betterdb-agent-cache[langchain]" langchain-openai`
- `langgraph`: `pip install "betterdb-agent-cache[langgraph]" langchain-openai`
- `monitor_proposals`: `pip install betterdb-agent-cache`

## No API key examples

This example runs without any API keys — it writes directly to Valkey to
simulate the Monitor configuration loop:
- `monitor_proposals`

## Examples requiring API keys

- `openai`, `openai_responses`, `llamaindex`, `langchain`, `langgraph`: require `OPENAI_API_KEY`
- `anthropic`: requires `ANTHROPIC_API_KEY`
