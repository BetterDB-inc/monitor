# @betterdb/valkey-search-kit

[![npm version](https://img.shields.io/npm/v/@betterdb%2Fvalkey-search-kit)](https://www.npmjs.com/package/@betterdb/valkey-search-kit)
[![total downloads](https://img.shields.io/npm/dt/@betterdb%2Fvalkey-search-kit)](https://www.npmjs.com/package/@betterdb/valkey-search-kit)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![types](https://img.shields.io/npm/types/@betterdb%2Fvalkey-search-kit)](https://www.npmjs.com/package/@betterdb/valkey-search-kit)
[![GitHub stars](https://img.shields.io/github/stars/BetterDB-inc/monitor?style=social)](https://github.com/BetterDB-inc/monitor)

Shared low-level helpers for working with [Valkey Search](https://valkey.io/) (`FT.*` commands): vector byte encoding, `FT.SEARCH` reply parsing, version-skew-tolerant `FT.INFO` parsing, TAG filter escaping, and error classification. Consumed by [`@betterdb/semantic-cache`](../semantic-cache/) and intended as the foundation for future retrieval and agent-memory packages.

## See it live in BetterDB Monitor

[BetterDB Monitor](https://github.com/BetterDB-inc/monitor) gives you live dashboards for the AI workloads running on your Valkey:

- **AI Cache & Memory** - hit rate, cost saved, evictions, and index size across all your caches and memory stores, with history.
- **AI Traces** - OpenTelemetry waterfalls for each request, correlated with live Valkey state to explain every cache hit and miss.

![AI Cache & Memory tab in BetterDB Monitor](https://raw.githubusercontent.com/BetterDB-inc/monitor/master/.github/assets/ai-cache-memory.png)

![AI Traces waterfall in BetterDB Monitor](https://raw.githubusercontent.com/BetterDB-inc/monitor/master/.github/assets/ai-traces.png)

Run it self-hosted (`docker run -p 3001:3001 betterdb/monitor`), or use [BetterDB Cloud](https://betterdb.com) - which can also **provision a managed, TLS-enabled Valkey instance with the Search module in one click** - exactly what this library needs.

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
