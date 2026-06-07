# cache-benchmark

Replay harness for benchmarking semantic cache implementations against labeled query-pair datasets. Compares BetterDB, RedisVL, and GPTCache across multiple modes, thresholds, and datasets with reproducible results.

## Setup

```bash
uv sync
```

Requires a running Valkey instance with the `valkey-search` module:

```bash
docker run -d --name valkey-bench -p 6381:6379 valkey/valkey-bundle:8-alpine
```

## Datasets

Four public datasets are supported:

| Dataset | Source | Pairs | Categories | What it tests |
|---|---|---|---|---|
| `vcache_lmarena` | [vCache/SemBenchmarkLmArena](https://huggingface.co/datasets/vCache/SemBenchmarkLmArena) | ~1.2M (use `--limit`) | Equivalence classes | Realistic chatbot prompt reuse |
| `paws_wiki` | [google-research-datasets/paws](https://huggingface.co/datasets/google-research-datasets/paws) | 8,000 | Single | Adversarial paraphrases (false-positive stress test) |
| `stsb` | [mteb/stsbenchmark-sts](https://huggingface.co/datasets/mteb/stsbenchmark-sts) | 8,628 | 3 genres (news, caption, forum) | Continuous similarity scores, threshold boundary stress |
| `sick` | [mteb/sickr-sts](https://huggingface.co/datasets/mteb/sickr-sts) | 9,927 | 3 score bands (high, medium, low) | Compositional semantics, ambiguous middle band |

STSb and SICK have continuous human-annotated similarity scores (0-5). The `--match-threshold` option (default 0.6, i.e. 3.0/5.0) controls the binary cutoff for ground-truth labeling.

## Modes

| Mode | What it does | Requires |
|---|---|---|
| `bare` | Cosine distance threshold only | Valkey |
| `local` | + top-3 candidate retrieval + keyword-overlap rerank | Valkey |
| `full` | + LLM-as-judge gate (gpt-4o-mini) on uncertain hits | Valkey + `OPENAI_API_KEY` |
| `autotune` | Bare + Monitor-driven threshold autotuning | Valkey + Monitor API (`BETTERDB_URL`, `BETTERDB_TOKEN`, `BETTERDB_INSTANCE_ID`) |
| `autotune-full` | Full + Monitor-driven threshold autotuning | Valkey + Monitor API + `OPENAI_API_KEY` |

RedisVL and GPTCache only support `bare`/`local`/`full` (no native autotuning). Autotune modes are skipped for non-BetterDB adapters.

## Usage

```bash
# Basic sweep across thresholds
uv run cache-bench --dataset stsb --adapter betterdb --mode bare \
  --thresholds 0.10,0.15,0.20,0.30,0.40 --limit 5000

# Compare adapters
uv run cache-bench --dataset sick --adapter all --mode bare --limit 5000

# Autotune (requires Monitor running)
BETTERDB_URL=http://localhost:3001 \
BETTERDB_TOKEN=local-dev \
BETTERDB_INSTANCE_ID=<id-from-monitor> \
uv run cache-bench --dataset stsb --adapter betterdb --mode autotune \
  --thresholds 0.15 --limit 5000

# Autotune + judge
BETTERDB_URL=http://localhost:3001 \
BETTERDB_TOKEN=local-dev \
BETTERDB_INSTANCE_ID=<id-from-monitor> \
OPENAI_API_KEY=sk-... \
uv run cache-bench --dataset sick --adapter betterdb --mode autotune-full \
  --thresholds 0.30 --limit 5000

# Debug judge verdicts (writes JSONL log)
OPENAI_API_KEY=sk-... \
uv run cache-bench --dataset stsb --adapter betterdb --mode full \
  --thresholds 0.30 --limit 1000 --debug-judge
```

## Output

Each run produces:
- `results/{adapter}_{mode}_{dataset}_{threshold}.json` — full metrics + per-pair results
- `results/summary_{mode}_{dataset}.json` — aggregated metrics across thresholds
- `results/threshold_trajectory_{adapter}_{mode}_{dataset}_{threshold}.jsonl` — autotune modes only, one line per check with effective threshold and recommendation
- `results/judge_log_{adapter}_{mode}_{dataset}_{threshold}.jsonl` — `--debug-judge` only, every judge invocation with verdict

## CLI reference

```
Options:
  --adapter [betterdb|redisvl|gptcache|all]
  --dataset [vcache_lmarena|paws_wiki|stsb|sick]
  --limit INTEGER                 Max pairs per run
  --thresholds TEXT               Comma-separated cosine distance thresholds
  --embedding-model TEXT          Default: sentence-transformers/all-MiniLM-L6-v2
  --redis-url TEXT                Default: redis://localhost:6381
  --output TEXT                   Output directory (default: ./results)
  --mode [bare|local|full|autotune|autotune-full]
  --match-threshold FLOAT         STSb/SICK only: normalized score cutoff (default: 0.6)
  --debug-judge                   Log every LLM judge call to JSONL
```

## Benchmark notes

The `dense` store mode uses a generic constant as the stored response instead of the prompt-derived `"Answer: {prompt}"` used by the default `paired` mode. Response-axis overlap (`--rerank-compare response`) numbers generated under `dense` are not comparable to `paired` numbers, because the old response text leaked prompt tokens and inflated overlap. Prompt-axis (`--rerank-compare prompt`) and bare-cosine numbers are unaffected by this difference.

## License

Apache 2.0
