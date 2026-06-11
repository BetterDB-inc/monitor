# LLM-as-judge example

Demonstrates the `judge` option for adjudicating borderline cache hits.

Uses a mocked judgeFn — **no API key or LLM required**. Replace `mockJudge` in `index.ts` with a real LLM call (see the `## LLM-as-judge` section in the package README for an OpenAI example).

## Prerequisites

- Valkey 8.0+ with valkey-search running at `localhost:6399`
  ```bash
  docker run -p 6399:6379 valkey/valkey-bundle:latest
  ```

## Run

```bash
pnpm install
pnpm start
```

## What it shows

1. Paraphrase query → borderline hit → judge called → accept or reject
2. Unrelated query → miss → judge not called
3. Exact match → high-confidence hit → judge not called

## Key concepts

- `judgeFn` receives `{ prompt, response, similarity, threshold, category, signal }`
- Return `true` to accept (→ `confidence: 'high'`)
- Return `false` to reject (→ `hit: false`, `nearestMiss.deltaToThreshold <= 0`)
- `onError: 'accept'` makes the judge fail-open (safe default)
- `timeoutMs` limits how long the judge can take
