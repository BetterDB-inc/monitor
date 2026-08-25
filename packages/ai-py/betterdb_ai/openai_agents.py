"""OpenAI Agents SDK adapter.

Only ``betterdb-agent-cache`` ships this adapter; there is no semantic-cache
counterpart, so this module has no ``prepare_semantic_params``.
"""

from betterdb_agent_cache.adapters.openai_agents import (
    CachedModel,
    CachedModelProvider,
    OpenAIAgentsPrepareOptions,
    prepare_params,
)

__all__ = [
    "CachedModel",
    "CachedModelProvider",
    "OpenAIAgentsPrepareOptions",
    "prepare_params",
]
