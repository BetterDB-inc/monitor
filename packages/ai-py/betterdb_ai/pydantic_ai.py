"""Pydantic AI adapter.

Only ``betterdb-agent-cache`` ships this adapter; there is no semantic-cache
counterpart, so this module has no ``prepare_semantic_params``.
"""

from betterdb_agent_cache.adapters.pydantic_ai import (
    CachedModel,
    PydanticAIPrepareOptions,
    prepare_params,
)

__all__ = ["CachedModel", "PydanticAIPrepareOptions", "prepare_params"]
