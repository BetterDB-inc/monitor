from __future__ import annotations

import math
from dataclasses import dataclass

from betterdb_valkey_search_kit import encode_float32

DEFAULT_IMPORTANCE = 0.5


@dataclass
class MemoryWrite:
    key: str
    fields: list[str | bytes]


def build_memory_record(
    name: str,
    id: str,
    content: str,
    vector: list[float],
    *,
    importance: float | None = None,
    tags: list[str] | None = None,
    source: str | None = None,
    subject: str | None = None,
    date: str | None = None,
    thread_id: str | None = None,
    agent_id: str | None = None,
    namespace: str | None = None,
    now: int,
) -> MemoryWrite:
    imp = importance if importance is not None else DEFAULT_IMPORTANCE
    if not isinstance(imp, (int, float)) or not math.isfinite(imp) or imp < 0 or imp > 1:
        raise ValueError(f"importance must be a finite number in [0, 1], got: {importance}")

    fields: list[str | bytes] = [
        "content",
        content,
        "vector",
        encode_float32(vector),
        "importance",
        str(imp),
        "created_at",
        str(now),
        "last_accessed_at",
        str(now),
        "access_count",
        "0",
    ]

    tag_list = tags if tags is not None else []
    for tag in tag_list:
        if "," in tag:
            raise ValueError(
                f"Tag '{tag}' must not contain a comma; tags are stored comma-separated"
            )
    if len(tag_list) > 0:
        fields.extend(["tags", ",".join(tag_list)])

    if thread_id is not None:
        fields.extend(["threadId", thread_id])
    if agent_id is not None:
        fields.extend(["agentId", agent_id])
    if namespace is not None:
        fields.extend(["namespace", namespace])
    if source is not None:
        fields.extend(["source", source])
    if subject is not None:
        fields.extend(["subject", subject])
    if date is not None and date != "":
        fields.extend(["date", date])

    return MemoryWrite(key=f"{name}:mem:{id}", fields=fields)
