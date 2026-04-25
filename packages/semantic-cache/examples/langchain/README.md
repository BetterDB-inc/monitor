# LangChain example

Demonstrates `BetterDBSemanticCache` (implements LangChain's `BaseCache`) wired into a `ChatOpenAI` model. Similar prompts hit the semantic cache without calling the LLM API.

## Prerequisites

- Valkey 8.0+ with valkey-search at localhost:6399 (or set `VALKEY_HOST`/`VALKEY_PORT`)
- `OPENAI_API_KEY` environment variable set

## Run

```bash
pnpm install && pnpm start
```

## Expected output

```
=== LangChain + BetterDBSemanticCache example ===

=== Round 1: First call (cache miss, calls LLM) ===
User: What is the capital of Spain?
Assistant: The capital of Spain is Madrid.
  (1243ms)

=== Round 2: Same prompt (cache hit) ===
User: What is the capital of Spain?
Assistant: The capital of Spain is Madrid.
  (45ms)

=== Round 3: Paraphrase (semantic cache hit) ===
User: Which city is the capital of Spain?
Assistant: The capital of Spain is Madrid.
  (553ms)

=== Round 4: Unrelated (cache miss) ===
User: What is the best pizza topping?
Assistant: The "best" pizza topping often depends on personal preference, but some popular choices include pepp...
  (1903ms)

-- Cache Stats --
Hits: 2 | Misses: 2 | Hit rate: 50%
```
