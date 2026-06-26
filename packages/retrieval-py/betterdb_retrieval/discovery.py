from __future__ import annotations

from typing import TypedDict

from .ft_create import index_name

REGISTRY_KEY = "__betterdb:caches"
RETRIEVAL_PROTOCOL_VERSION = 1
RETRIEVAL_CACHE_TYPE = "retrieval"
# TODO: sync with pyproject.toml rather than hardcoding — this drifts on a
# version bump.
RETRIEVAL_VERSION = "0.1.0"


class RetrievalMarker(TypedDict):
    type: str
    prefix: str
    version: str
    protocol_version: int
    capabilities: list[str]
    index_name: str
    started_at: str


def build_retrieval_marker(name: str, version: str, started_at: str) -> RetrievalMarker:
    return {
        "type": RETRIEVAL_CACHE_TYPE,
        "prefix": name,
        "version": version,
        "protocol_version": RETRIEVAL_PROTOCOL_VERSION,
        "capabilities": ["upsert", "query", "delete"],
        "index_name": index_name(name),
        "started_at": started_at,
    }
