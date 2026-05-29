# Cache Benchmark (TypeScript)

TypeScript semantic cache benchmark harness, mirroring the [Python benchmark](../cache-benchmark/README.md) for `@betterdb/semantic-cache`.

## Prerequisites

- **Node.js >= 20**
- **Valkey 8.0+** with `valkey-search` module (port 6381 by default) — for `betterdb` adapter
- **Upstash Vector index** — for `upstash` adapter (cloud-hosted)

## Setup

```bash
cd packages/cache-benchmark-ts
pnpm install
```

Set environment variables:

```bash
# For betterdb adapter with OpenAI embeddings:
export OPENAI_API_KEY=sk-...

# For betterdb autotune modes:
export BETTERDB_URL=http://localhost:3001
export BETTERDB_TOKEN=...
export BETTERDB_INSTANCE_ID=...

# For upstash adapter:
export UPSTASH_VECTOR_REST_URL=https://...upstash.io
export UPSTASH_VECTOR_REST_TOKEN=...
```

## Adapters

| Adapter | Backend | Embedding | Notes |
|---------|---------|-----------|-------|
| `betterdb` | Local Valkey | Local (all-MiniLM-L6-v2) or OpenAI | All modes supported |
| `upstash` | Upstash Vector (cloud) | Server-side (configured at index creation) | bare mode only; latency includes network round-trip |

## Datasets

| Dataset | Pairs | Description |
|---------|-------|-------------|
| `stsb` | 8,628 (all splits) | Continuous similarity scores, 3 genres |
| `sick` | 9,927 (test) | Compositional semantics, 3 score bands |
| `paws_wiki` | 8,000 (test) | Adversarial paraphrases (FP stress test) |
| `vcache_lmarena` | ~1.2M (train) | Realistic chatbot reuse (use `--limit`) |

Datasets are fetched from HuggingFace on first run. No local download required.

## Modes

| Mode | Features |
|------|----------|
| `bare` | Cosine-distance threshold only |
| `local` | + k=3 keyword-overlap rerank |
| `full` | + LLM-as-judge (gpt-4o-mini) on uncertain hits |
| `autotune` | bare + Monitor-driven threshold evolution |
| `autotune-full` | full + Monitor-driven threshold evolution |

## Usage

```bash
# Basic run with STSb
pnpm bench -- --adapter betterdb --dataset stsb --mode bare --limit 500

# Sweep thresholds
pnpm bench -- --adapter betterdb --dataset paws_wiki --thresholds 0.05,0.10,0.15,0.20

# Full mode with report
pnpm bench -- --adapter betterdb --dataset sick --mode full --report

# OpenAI embedding model (requires OPENAI_API_KEY)
pnpm bench -- --adapter betterdb --dataset stsb --embedding-model text-embedding-3-small

# Custom Valkey URL
pnpm bench -- --adapter betterdb --dataset stsb --redis-url redis://localhost:6399

# Upstash adapter (requires UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN)
pnpm bench -- --adapter upstash --dataset stsb --thresholds 0.1,0.2,0.3
```

## Output

Results are written to `./results/` (configurable via `--output`):

- `{adapter}_{mode}_{dataset}_{threshold}.json` -- per-run results with full replay data
- `summary_{mode}_{dataset}.json` -- aggregated metrics across thresholds
- `report_{mode}_{dataset}.md` -- markdown report (with `--report` flag)

Output JSON uses snake_case keys for compatibility with the Python harness report/validation tools.

## CLI Reference

| Option | Default | Description |
|--------|---------|-------------|
| `--adapter` | (required) | `betterdb`, `upstash` |
| `--dataset` | (required) | `stsb`, `sick`, `paws_wiki`, `vcache_lmarena` |
| `--mode` | `bare` | Benchmark mode |
| `--thresholds` | `0.05,...,0.45` | Comma-separated cosine distance thresholds |
| `--limit` | `1000` | Max pairs per run |
| `--match-threshold` | `0.6` | STSb/SICK normalized similarity cutoff (3.0/5.0) |
| `--embedding-model` | `Xenova/all-MiniLM-L6-v2` | Embedding model (local sentence-transformers or OpenAI `text-embedding-*`) |
| `--redis-url` | `redis://localhost:6381` | Valkey connection URL |
| `--output` | `./results` | Output directory |
| `--report` | `false` | Generate markdown report |
