# Release Notes — @betterdb/semantic-cache v0.5.0

## What's New

v0.5.0 adds LLM-as-judge adjudication for borderline cache hits. This is a direct response to user feedback from chat.betterdb.com: single-threshold matching produced too many `confidence: 'uncertain'` returns that callers had to handle themselves. With the judge, you can plug in an LLM call (or any async function) to make the accept/reject call on ambiguous hits automatically.

## Installation

```bash
npm install @betterdb/semantic-cache@0.5.0 iovalkey
```

## Highlights

### LLM-as-judge for borderline hits

Supply a `judgeFn` on any `check()` call. It fires only when the cosine distance lands in the uncertainty band:

```typescript
import { SemanticCache } from '@betterdb/semantic-cache';
import Valkey from 'iovalkey';
import OpenAI from 'openai';

const openai = new OpenAI();
const cache = new SemanticCache({
  client: new Valkey(),
  embedFn: async (text) => (await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  })).data[0].embedding,
  defaultThreshold: 0.15,
  uncertaintyBand: 0.07,
});
await cache.initialize();

const result = await cache.check(userPrompt, {
  judge: {
    judgeFn: async ({ prompt, response, similarity }) => {
      const verdict = await openai.chat.completions.create({
        model: 'gpt-5-mini',
        messages: [
          { role: 'system', content: 'You decide whether a cached response correctly answers a user prompt. Reply with only YES or NO.' },
          { role: 'user', content: `Prompt: ${prompt}\n\nCached response: ${response}\n\nDoes the response correctly answer the prompt?` },
        ],
      });
      return verdict.choices[0].message.content?.trim().toUpperCase().startsWith('YES') ?? false;
    },
    onError: 'accept',   // fail-open: return cached result if judge throws
    timeoutMs: 1500,     // give the LLM 1.5 seconds
  },
});

if (result.hit && result.confidence === 'high') {
  // Judge accepted — use the cached response
  return result.response;
}
if (!result.hit && result.nearestMiss) {
  // Judge rejected — nearestMiss.deltaToThreshold <= 0 identifies this path
  console.log('Judge-rejected borderline hit, falling back to LLM');
}
```

### What happens in each case

| Score range | Judge called? | Accept path | Reject path |
|---|---|---|---|
| `<= threshold - band` | No | `confidence: 'high'` | — |
| `(threshold - band, threshold]` | Yes | `confidence: 'high'` | `hit: false`, `nearestMiss.deltaToThreshold <= 0` |
| `> threshold` | No | — | `confidence: 'miss'` |

### Error and timeout handling

`onError: 'accept'` (default) returns the cached entry with `confidence: 'uncertain'` when `judgeFn` throws or times out — fail-open. `onError: 'reject'` treats errors as rejections — fail-closed.

Prometheus counters track each outcome: `accept`, `reject`, `error_accept`, `error_reject`, `timeout_accept`, `timeout_reject`.

### New Prometheus metrics

```
semantic_cache_judge_decisions_total{cache_name, category, decision}
semantic_cache_judge_duration_seconds{cache_name, category, decision}
```

### OTel span attributes added on every judge invocation

```
cache.judge.invoked = true
cache.judge.decision = "accept" | "reject" | ...
cache.judge.latency_ms = <float>
```

## Breaking changes

None.

## Links

- [CHANGELOG](./CHANGELOG.md)
- [Examples](./examples/judge/)
