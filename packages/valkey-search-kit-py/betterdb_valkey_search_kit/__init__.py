"""Shared Valkey Search (FT.*) helpers for BetterDB packages.

Mirrors the TypeScript ``@betterdb/valkey-search-kit`` package: float32 vector
encoding, FT.SEARCH reply parsing, version-skew-tolerant FT.INFO parsing, TAG
escaping, and "index does not exist" error classification.
"""

from __future__ import annotations

from .encoding import decode_float32, encode_float32
from .errors import is_index_not_found_error
from .ft_info import FtIndexStats, parse_dimension_from_info, parse_ft_info_stats
from .ft_search import FtSearchHit, parse_ft_search_response
from .tags import escape_tag

__all__ = [
    "encode_float32",
    "decode_float32",
    "escape_tag",
    "parse_ft_search_response",
    "FtSearchHit",
    "parse_dimension_from_info",
    "parse_ft_info_stats",
    "FtIndexStats",
    "is_index_not_found_error",
]
