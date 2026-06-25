from __future__ import annotations

from betterdb_valkey_search_kit import FtSearchHit

from ._num import parse_float, parse_int
from .types import MemoryItem


def parse_memory_item(name: str, hit: FtSearchHit) -> MemoryItem:
    prefix = f"{name}:mem:"
    key = hit["key"]
    id = key[len(prefix) :] if key.startswith(prefix) else key

    fields = hit["fields"]
    item = MemoryItem(
        id=id,
        content=fields.get("content", ""),
        importance=parse_float(fields.get("importance", "0")),
        tags=fields["tags"].split(",") if fields.get("tags") else [],
        created_at=parse_int(fields.get("created_at", "0")),
        last_accessed_at=parse_int(fields.get("last_accessed_at", "0")),
        access_count=parse_int(fields.get("access_count", "0")),
    )

    if "source" in fields:
        item.source = fields["source"]
    if "threadId" in fields:
        item.thread_id = fields["threadId"]
    if "agentId" in fields:
        item.agent_id = fields["agentId"]
    if "namespace" in fields:
        item.namespace = fields["namespace"]

    return item
