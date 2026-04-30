# @betterdb/cache-fixtures

Seed scripts that populate Valkey with realistic semantic-cache and agent-cache state. Used by:

- **Cache-proposals integration tests** — import scenario `run()` functions in `apps/api/test/cache-proposals*.e2e-spec.ts` to seed Valkey before the test exercises propose/approve/apply.
- **Dogfood walkthroughs** — run via CLI against a local valkey-bundle to set up the threshold-tuning, tool-TTL-tuning, and invalidate-after-bad-deploy demos from `docs/plans/specs/spec-cache-proposals-tests-and-dogfood.md`.

## Prerequisites

- Valkey with the search module. Local dev:
  ```bash
  docker run --rm -p 6399:6379 valkey/valkey-bundle:unstable
  ```
  The test infrastructure already runs one on port 6391 (see `docker-compose.test.yml`).
- Ollama with an embedding model:
  ```bash
  ollama serve
  ollama pull nomic-embed-text
  ```
  Embeddings are cached to `.embeddings/<model>.jsonl`, so subsequent runs reuse them and don't need Ollama.

## Run a scenario

```bash
pnpm --filter @betterdb/cache-fixtures seed -- --list
pnpm --filter @betterdb/cache-fixtures seed -- --scenario faq-cache-bimodal --port 6399
```

Flags:
- `--scenario <id>` (required) — see `--list`
- `--host <host>` (default `localhost`, env `SEED_VALKEY_HOST`)
- `--port <port>` (default `6391`, env `SEED_VALKEY_PORT`)
- `--password <pw>` (env `SEED_VALKEY_PASSWORD`)
- `--cache-name <name>` — override scenario default
- `--list` / `--help`

Embedding configuration:
- `OLLAMA_HOST` (default `http://localhost:11434`)
- `EMBED_MODEL` (default `nomic-embed-text`)

## Scenarios

| ID | Cache | Purpose |
|---|---|---|
| `faq-cache-bimodal` | semantic | FAQ prompts split across billing + support topics. Bimodal embedding distribution. Drives threshold-tuning walkthrough. |
| `prod-agent-three-tools` | agent | Three tools (`weather_lookup`, `classify_intent`, `lookup_user`) with distinct TTL policies. Drives tool-TTL-tuning walkthrough. |
| `agent-invalidate-by-tool` | agent | Equal entries across 3 tools. Used by invalidate-by-tool tests. |
| `agent-invalidate-by-session` | agent | Conversation turns across 3 sessions. Used by invalidate-by-session tests. |
| `semantic-invalidate-by-model` | semantic | 500 entries split across two models (target ratio 0.6). Used by semantic invalidate tests. |

## Tunable counts

Scale defaults are intentionally small for tests. Bump via env vars for dogfood:

| Env | Default | Used by |
|---|---|---|
| `FAQ_PER_TOPIC` | 100 | `faq-cache-bimodal` |
| `AGENT_INVALIDATE_PER_TOOL` | 100 | `agent-invalidate-by-tool` |
| `AGENT_INVALIDATE_PER_SESSION` | 40 | `agent-invalidate-by-session` |
| `SEMANTIC_INVALIDATE_TOTAL` | 500 | `semantic-invalidate-by-model` |

## Importing from tests

```ts
import { faqCacheBimodal, createEmbedder } from '@betterdb/cache-fixtures';

beforeAll(async () => {
  const embedFn = await createEmbedder();
  await faqCacheBimodal.run({
    valkeyHost: 'localhost',
    valkeyPort: 6391,
    valkeyPassword: 'devpassword',
    cacheName: 'faq-cache-test',
    embedFn,
  });
});
```
