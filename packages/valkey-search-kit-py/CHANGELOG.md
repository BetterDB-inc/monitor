# Changelog

## [0.1.0] - 2026-06-23

### Added

- Initial release. Python equivalent of the TypeScript `@betterdb/valkey-search-kit`.
- `encode_float32` / `decode_float32` — little-endian Float32 vector encoding for embeddings.
- `escape_tag` — TAG filter value escaping (including spaces).
- `parse_ft_search_response` — bytes-aware FT.SEARCH reply parsing; never raises.
- `parse_dimension_from_info` / `parse_ft_info_stats` — version-skew-tolerant FT.INFO parsing.
- `is_index_not_found_error` — "index does not exist" error classification.
