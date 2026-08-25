"""OpenAI Chat Completions adapters for both caches, behind one import."""

from betterdb_agent_cache.adapters.openai import OpenAIPrepareOptions, prepare_params
from betterdb_semantic_cache.adapters.openai import SemanticParams, prepare_semantic_params

__all__ = [
    "OpenAIPrepareOptions",
    "SemanticParams",
    "prepare_params",
    "prepare_semantic_params",
]
