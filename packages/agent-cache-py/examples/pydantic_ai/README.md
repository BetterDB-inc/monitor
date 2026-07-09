# Pydantic AI example

This example shows how to wrap a Pydantic AI `Model` with `CachedModel` so
LLM responses are served from `betterdb-agent-cache` on repeat requests.

It demonstrates:
- text prompts
- tool-calling flows
- multi-turn message history

## Install

```bash
docker run -d --name valkey -p 6379:6379 valkey/valkey:8
pip install "betterdb-agent-cache[pydantic_ai]"
export OPENAI_API_KEY=sk-...
```

## Run

```bash
python main.py
```

## Expected output

The first call in each scenario is a miss and the second is a hit. At the end,
cache stats show non-zero LLM hits and a positive cost-saved value.
