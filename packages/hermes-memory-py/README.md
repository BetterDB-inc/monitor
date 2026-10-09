# betterdb-hermes-memory

A [Hermes](https://github.com/NousResearch/hermes-agent) memory provider backed by
[`betterdb-agent-memory`](https://pypi.org/project/betterdb-agent-memory/) on
Valkey / valkey-search.

It gives a Hermes agent durable, semantic long-term memory: each completed turn is
embedded and written to a Valkey vector index, and the next turn recalls the most
relevant memories — ranked by a composite of similarity, recency (half-life decay),
and importance — and injects them as a recall block. It also exposes explicit
`betterdb_remember` / `betterdb_recall` / `betterdb_forget` tools.

## How it maps to the `MemoryProvider` contract

| SDK operation            | Hermes hook                                        |
| ------------------------ | -------------------------------------------------- |
| `MemoryStore.recall()`   | `queue_prefetch()` (background) → `prefetch()` cache |
| `MemoryStore.remember()` | `sync_turn()` (per turn) + `on_memory_write()` mirror |
| `MemoryStore.forget()`   | `betterdb_forget` tool                             |

`prefetch()` is non-blocking: `queue_prefetch()` submits the recall to a background
event loop and stashes a formatted block in an in-memory cache; `prefetch()` only
reads that cache, so a turn never waits on a Valkey round-trip. `is_available()` is
network-free — it checks that the SDK imports, a connection target is configured,
and an embedding source is resolvable.

## Requirements

- Python **3.11–3.14** (matches Hermes's own `>=3.11,<3.15`).
- A Valkey server with the **Search** module (e.g. `valkey/valkey-bundle`).
- An **embeddings endpoint**. `betterdb-agent-memory` does not ship an embedding
  model — you point this provider at an OpenAI-compatible `/v1/embeddings` endpoint
  (OpenAI, Azure OpenAI, Ollama, vLLM, LM Studio, a gateway, …).

## Install

### As a dropped-in plugin

Copy the package into your Hermes plugins directory and select it:

```bash
cp -r packages/hermes-memory-py/betterdb_hermes_memory ~/.hermes/plugins/betterdb
# then, in Hermes config, set:  memory.provider: betterdb
```

### As a pip package (entry point)

```bash
pip install betterdb-hermes-memory
```

The package registers the `hermes_agent.memory_providers` entry point
`betterdb = betterdb_hermes_memory:register`, so Hermes discovers it by name. Select
it with `memory.provider: betterdb`.

## Configuration

Run `hermes memory setup` for the provider, or set the fields directly. Non-secret
fields live in `config.yaml` under `memory.betterdb`; secrets go to the scoped
secret store (env vars).

| Field                  | Env (secrets)                          | Default              |
| ---------------------- | -------------------------------------- | -------------------- |
| `host`                 | —                                      | `127.0.0.1`          |
| `port`                 | —                                      | `6379`               |
| `db`                   | —                                      | `0`                  |
| `username`             | —                                      | (none)               |
| `password`             | `BETTERDB_MEMORY_PASSWORD`             | (none)               |
| `tls`                  | —                                      | `false`              |
| `url`                  | `BETTERDB_MEMORY_URL`                  | (overrides host/port)|
| `store_name`           | —                                      | `hermes`             |
| `namespace`            | —                                      | (none)               |
| `embeddings_model`     | —                                      | `text-embedding-3-small` |
| `embeddings_base_url`  | —                                      | `https://api.openai.com/v1` |
| `embeddings_api_key`   | `BETTERDB_MEMORY_EMBEDDINGS_API_KEY`   | (none)               |

A custom `embeddings_base_url` (a local/self-hosted endpoint) is treated as needing
no key; the hosted default requires `embeddings_api_key`.

## Notes on the embeddings requirement

The SDK's `MemoryStore` takes an `embed_fn` that the host supplies — it is required
for `remember` / `recall` / `ensure_index`. Because Hermes does not hand providers
an embedding seam, this provider resolves one from the embeddings config above
(see `embeddings.py`). You can also inject an `embed_fn` directly into
`BetterDBMemoryProvider(...)` if you wire the provider yourself.

## Development

```bash
pip install -e ".[dev]"
pytest
```

The unit tests mock the SDK client and the event-loop runtime, so they need neither
a live Valkey nor an embeddings endpoint.

## License

MIT
