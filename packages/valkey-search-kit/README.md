# @betterdb/valkey-search-kit

Shared low-level helpers for working with [Valkey Search](https://valkey.io/) (`FT.*` commands): vector byte encoding, `FT.SEARCH` reply parsing, version-skew-tolerant `FT.INFO` parsing, TAG filter escaping, and error classification. Consumed by [`@betterdb/semantic-cache`](../semantic-cache/) and intended as the foundation for future retrieval and agent-memory packages.

## Installation

```bash
npm install @betterdb/valkey-search-kit
```

## Exports

- `encodeFloat32(vec)` — encode a `number[]` embedding as a little-endian Float32 `Buffer` for binary `HSET` field values.
- `escapeTag(value)` — escape a string for safe use as a Valkey Search TAG filter value (including spaces, which would otherwise split into OR terms).
- `parseFtSearchResponse(raw)` — parse a raw `FT.SEARCH` reply into `FtSearchHit[]`; never throws, returns `[]` on empty or malformed input.
- `FtSearchHit` — `{ key: string; fields: Record<string, string> }`, a single parsed search hit.
- `parseDimensionFromInfo(info)` — extract the vector field dimension from an `FT.INFO` reply, handling both flat `DIM` pairs and the Valkey Search 1.2 nested `index`/`dimensions` shape.
- `parseFtInfoStats(info)` — extract `num_docs` and indexing state from an `FT.INFO` reply as `FtIndexStats`.
- `isIndexNotFoundError(err)` — classify an error as a Valkey Search "index does not exist" error across Valkey Search / RediSearch message variants.

## License

MIT
