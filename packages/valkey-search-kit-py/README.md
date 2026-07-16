# @betterdb/valkey-search-kit (Python)

[![PyPI version](https://img.shields.io/pypi/v/betterdb-valkey-search-kit)](https://pypi.org/project/betterdb-valkey-search-kit/)
[![total downloads](https://static.pepy.tech/badge/betterdb-valkey-search-kit)](https://pepy.tech/project/betterdb-valkey-search-kit)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![python](https://img.shields.io/pypi/pyversions/betterdb-valkey-search-kit)](https://pypi.org/project/betterdb-valkey-search-kit/)
[![GitHub stars](https://img.shields.io/github/stars/BetterDB-inc/monitor?style=social)](https://github.com/BetterDB-inc/monitor)

`betterdb-valkey-search-kit` — shared low-level helpers for working with Valkey
Search (`FT.*`) from Python. This is the Python equivalent of the TypeScript
`@betterdb/valkey-search-kit` package, and the shared foundation the
`betterdb-retrieval` and `betterdb-agent-memory` packages build on.

It has **no runtime dependencies** and exposes only pure functions, so it stays
trivial to vendor and test.

## See it live in BetterDB Monitor

[BetterDB Monitor](https://github.com/BetterDB-inc/monitor) gives you live dashboards for the AI workloads running on your Valkey:

- **AI Cache & Memory** - hit rate, cost saved, evictions, and index size across all your caches and memory stores, with history.
- **AI Traces** - OpenTelemetry waterfalls for each request, correlated with live Valkey state to explain every cache hit and miss.

![AI Cache & Memory tab in BetterDB Monitor](https://raw.githubusercontent.com/BetterDB-inc/monitor/master/.github/assets/ai-cache-memory.png)

![AI Traces waterfall in BetterDB Monitor](https://raw.githubusercontent.com/BetterDB-inc/monitor/master/.github/assets/ai-traces.png)

Run it self-hosted (`docker run -p 3001:3001 betterdb/monitor`), or use [BetterDB Cloud](https://betterdb.com) - which can also **provision a managed, TLS-enabled Valkey instance with the Search module in one click** - exactly what this library needs.

## Install

```bash
pip install betterdb-valkey-search-kit
```

## API

### Vector encoding

```python
from betterdb_valkey_search_kit import encode_float32, decode_float32

blob = encode_float32([0.1, 0.2, 0.3])   # little-endian Float32 bytes
vec = decode_float32(blob)               # back to list[float]
```

Use `encode_float32` to store embeddings as binary `HSET` field values and as
the `PARAMS` vector for a KNN `FT.SEARCH`.

### TAG escaping

```python
from betterdb_valkey_search_kit import escape_tag

f"@model:{{{escape_tag('gpt-4o')}}}"   # -> "@model:{gpt\\-4o}"
```

Escapes every character with special meaning in the TAG filter syntax,
**including spaces** (unescaped spaces are treated as OR term separators).

### FT.SEARCH reply parsing

```python
from betterdb_valkey_search_kit import parse_ft_search_response

raw = await client.execute_command("FT.SEARCH", index, query, ...)
hits = parse_ft_search_response(raw)
# [{"key": "cache:entry:abc", "fields": {"prompt": "...", "__score": "0.05"}}]
```

Handles valkey-py's mixed `bytes`/`str` replies, `RETURN 0` mode (keys with no
field list), and odd-length field lists. Binary field values that are not valid
UTF-8 (e.g. raw embedding bytes) are skipped. **Never raises** — returns `[]` on
any malformed input.

### FT.INFO parsing (version-skew tolerant)

```python
from betterdb_valkey_search_kit import (
    parse_dimension_from_info,
    parse_ft_info_stats,
)

info = await client.execute_command("FT.INFO", index)
dims = parse_dimension_from_info(info)        # 1536, or 0 if no vector field
stats = parse_ft_info_stats(info)             # FtIndexStats(num_docs=..., indexing_state=...)
```

`parse_dimension_from_info` understands both the flat `DIM` attribute pair and
the nested `index/dimensions` shape introduced in Valkey Search 1.2.

### Error classification

```python
from betterdb_valkey_search_kit import is_index_not_found_error

try:
    await client.execute_command("FT.INFO", index)
except Exception as err:
    if is_index_not_found_error(err):
        ...  # index does not exist yet
    else:
        raise
```

Matches the "index does not exist" message variants emitted across Valkey
Search / RediSearch versions, case-insensitively.

## Development

```bash
uv run --extra dev pytest tests -q
```
