# betterdb-hermes-memory v0.1.0

A Hermes Agent memory provider backed by `betterdb-agent-memory` on Valkey /
valkey-search. Each completed turn is embedded and written to a Valkey vector
index; the next turn recalls the most relevant memories, ranked by a composite
of similarity, recency (half-life decay), and importance.

- Non-blocking recall: the Valkey round-trip runs on a background loop, so a
  turn never waits on it.
- Explicit `betterdb_remember` / `betterdb_recall` / `betterdb_forget` tools,
  with `forget` scoped to the caller's agent and namespace.
- Bring-your-own embeddings (any OpenAI-compatible `/v1/embeddings` endpoint).
  Plaintext `http://` is refused for remote hosts.
- Discovery and analytics are both opt-in, off by default.
