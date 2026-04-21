"""LangGraph checkpoint saver adapter.

Implements LangGraph's ``BaseCheckpointSaver`` backed by the AgentCache
session tier. Works on vanilla Valkey 7+ — no modules, no RedisJSON, no
RediSearch required.

Storage layout in the session tier:
  ``{name}:session:{thread_id}:checkpoint:{checkpoint_id}`` = JSON(CheckpointTuple)
  ``{name}:session:{thread_id}:__checkpoint_latest``        = JSON(latest CheckpointTuple)
  ``{name}:session:{thread_id}:writes:{ckpt_id}|{task_id}|{channel}|{idx}`` = JSON(value)

Known limitations:
  - The general ``alist()`` path loads all checkpoint data for a thread before
    filtering (via ``get_all()``), which refreshes TTL via the sliding window.
    For typical agent deployments this is fine; for threads with thousands of
    large checkpoints consider a dedicated Redis 8+ checkpoint backend.

Usage::

    from betterdb_agent_cache.adapters.langgraph import BetterDBSaver

    saver = BetterDBSaver(cache=agent_cache)
    graph = builder.compile(checkpointer=saver)
"""
from __future__ import annotations

import json
from collections import ChainMap
from typing import TYPE_CHECKING, Any, AsyncIterator, Optional
from urllib.parse import quote, unquote


def _make_serializable(obj: Any) -> Any:
    """Recursively convert to JSON-safe types.

    - ChainMap → dict
    - Unserializable leaf values are dropped (returns sentinel and caller skips them)
    """
    if isinstance(obj, ChainMap):
        return _make_serializable(dict(obj))
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            converted = _make_serializable(v)
            if converted is not _SKIP:
                out[k] = converted
        return out
    if isinstance(obj, (list, tuple)):
        return [v for v in (_make_serializable(i) for i in obj) if v is not _SKIP]
    try:
        json.dumps(obj)
        return obj
    except (TypeError, ValueError):
        return _SKIP


_SKIP = object()  # sentinel for values that cannot be serialised


def _clean_config(config: Any) -> dict:
    """Return a storable copy of a LangGraph RunnableConfig.

    Strips internal ``__pregel_*`` keys from ``configurable`` — these hold
    non-serialisable runtime objects (Runtime, callbacks, etc.) that must not
    be persisted.
    """
    if not isinstance(config, dict):
        return {}
    configurable = dict(config.get("configurable") or {})
    for key in list(configurable):
        if key.startswith("__pregel_"):
            del configurable[key]
    return {**{k: v for k, v in config.items() if k != "configurable"},
            "configurable": configurable}

try:
    from langgraph.checkpoint.base import BaseCheckpointSaver, CheckpointTuple
    from langchain_core.runnables import RunnableConfig
    _LANGGRAPH_AVAILABLE = True
except ImportError:
    _LANGGRAPH_AVAILABLE = False
    BaseCheckpointSaver = object  # type: ignore[assignment,misc]
    CheckpointTuple = Any  # type: ignore[misc,assignment]
    RunnableConfig = Any  # type: ignore[misc,assignment]

from ..errors import AgentCacheUsageError

if TYPE_CHECKING:
    from ..agent_cache import AgentCache

_LATEST_FIELD = "__checkpoint_latest"


class BetterDBSaver(BaseCheckpointSaver):
    """LangGraph checkpoint saver backed by AgentCache session storage."""

    def __init__(self, cache: "AgentCache") -> None:
        if not _LANGGRAPH_AVAILABLE:
            raise ImportError(
                "langgraph and langchain-core are required for BetterDBSaver. "
                "Install them with: pip install betterdb-agent-cache[langgraph]"
            )
        super().__init__()
        self._cache = cache

    # ── Read ──────────────────────────────────────────────────────────────

    async def aget_tuple(self, config: RunnableConfig) -> Optional[CheckpointTuple]:
        thread_id: str = (config.get("configurable") or {}).get("thread_id", "")
        if not thread_id:
            return None

        checkpoint_id: str | None = (config.get("configurable") or {}).get("checkpoint_id")
        field = f"checkpoint:{checkpoint_id}" if checkpoint_id else _LATEST_FIELD

        data = await self._cache.session.get(thread_id, field)
        if not data:
            return None

        try:
            tuple_data: dict[str, Any] = json.loads(data)
        except (json.JSONDecodeError, ValueError):
            return None

        resolved_id = checkpoint_id or (tuple_data.get("checkpoint") or {}).get("id")
        if resolved_id:
            write_fields = await self._cache.session.scan_fields_by_prefix(
                thread_id, f"writes:{quote(resolved_id, safe='')}|"
            )
            pending = _extract_pending_writes(write_fields, resolved_id)
            if pending:
                tuple_data["pending_writes"] = pending

        return _dict_to_tuple(tuple_data)

    async def alist(  # type: ignore[override]
        self,
        config: Optional[RunnableConfig],
        *,
        filter: Optional[dict[str, Any]] = None,
        before: Optional[RunnableConfig] = None,
        limit: Optional[int] = None,
    ) -> AsyncIterator[CheckpointTuple]:
        async for item in self._alist_impl(config, filter=filter, before=before, limit=limit):
            yield item

    async def _alist_impl(
        self,
        config: Optional[RunnableConfig],
        *,
        filter: Optional[dict[str, Any]] = None,
        before: Optional[RunnableConfig] = None,
        limit: Optional[int] = None,
    ) -> AsyncIterator[CheckpointTuple]:  # type: ignore[override]
        thread_id: str = ((config or {}).get("configurable") or {}).get("thread_id", "")
        if not thread_id:
            return

        # Fast path: limit=1, no before filter → read the latest pointer directly
        if limit == 1 and not before:
            latest = await self._cache.session.get(thread_id, _LATEST_FIELD)
            if latest:
                try:
                    td: dict[str, Any] = json.loads(latest)
                    ckpt_id = (td.get("checkpoint") or {}).get("id")
                    if ckpt_id:
                        write_fields = await self._cache.session.scan_fields_by_prefix(
                            thread_id, f"writes:{quote(ckpt_id, safe='')}|"
                        )
                        pending = _extract_pending_writes(write_fields, ckpt_id)
                        if pending:
                            td["pending_writes"] = pending
                    yield _dict_to_tuple(td)
                except (json.JSONDecodeError, ValueError):
                    pass
            return

        # General path: load all fields, partition into checkpoints and writes
        all_fields = await self._cache.session.get_all(thread_id)
        write_map: dict[str, str] = {}
        checkpoints: list[dict[str, Any]] = []

        for field_name, value in all_fields.items():
            if field_name.startswith("writes:"):
                write_map[field_name] = value
            elif field_name.startswith("checkpoint:"):
                try:
                    checkpoints.append(json.loads(value))
                except (json.JSONDecodeError, ValueError):
                    pass

        # Attach pending writes
        for td in checkpoints:
            ckpt_id = (td.get("checkpoint") or {}).get("id")
            if ckpt_id:
                pending = _extract_pending_writes(write_map, ckpt_id)
                if pending:
                    td["pending_writes"] = pending

        # Sort by timestamp descending
        def _ts_key(td: dict[str, Any]) -> tuple[int, str]:
            ts: str = (td.get("checkpoint") or {}).get("ts", "")
            try:
                from datetime import datetime, timezone
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                return (1, dt.isoformat())
            except (ValueError, AttributeError):
                return (0, ts)

        checkpoints.sort(key=_ts_key, reverse=True)

        # Apply before filter
        before_id: str | None = ((before or {}).get("configurable") or {}).get("checkpoint_id")
        if before_id and not any((td.get("checkpoint") or {}).get("id") == before_id for td in checkpoints):
            return

        started = before_id is None
        yielded = 0

        for td in checkpoints:
            if not started:
                if (td.get("checkpoint") or {}).get("id") == before_id:
                    started = True
                continue
            if limit is not None and yielded >= limit:
                break
            # Apply metadata filter if provided
            if filter:
                meta = td.get("metadata") or {}
                if not all(meta.get(k) == v for k, v in filter.items()):
                    continue
            yield _dict_to_tuple(td)
            yielded += 1

    # ── Write ─────────────────────────────────────────────────────────────

    async def aput(
        self,
        config: RunnableConfig,
        checkpoint: Any,
        metadata: Any,
        new_versions: Any,
    ) -> RunnableConfig:
        thread_id = (config.get("configurable") or {}).get("thread_id")
        if not thread_id:
            raise AgentCacheUsageError("aput() requires config['configurable']['thread_id']")

        checkpoint_id = checkpoint.get("id") if isinstance(checkpoint, dict) else getattr(checkpoint, "id", None)
        clean = _clean_config(config)
        clean.setdefault("configurable", {})["checkpoint_id"] = checkpoint_id
        stored = {"config": clean, "checkpoint": checkpoint, "metadata": metadata}
        serialised = json.dumps(_make_serializable(stored))

        await self._cache.session.set(thread_id, f"checkpoint:{checkpoint_id}", serialised)
        await self._cache.session.set(thread_id, _LATEST_FIELD, serialised)

        return {
            **config,
            "configurable": {**(config.get("configurable") or {}), "checkpoint_id": checkpoint_id},
        }  # return original (with runtime objects) so LangGraph can continue using it

    async def aput_writes(
        self,
        config: RunnableConfig,
        writes: list[tuple[str, Any]],
        task_id: str,
    ) -> None:
        thread_id = (config.get("configurable") or {}).get("thread_id")
        checkpoint_id = (config.get("configurable") or {}).get("checkpoint_id")
        if not thread_id or not checkpoint_id:
            raise AgentCacheUsageError(
                "aput_writes() requires both thread_id and checkpoint_id in config['configurable']"
            )

        encoded_ckpt = quote(checkpoint_id, safe="")
        encoded_task = quote(task_id, safe="")
        import asyncio

        await asyncio.gather(*(
            self._cache.session.set(
                thread_id,
                f"writes:{encoded_ckpt}|{encoded_task}|{quote(channel, safe='')}|{i}",
                json.dumps(_make_serializable(value)),
            )
            for i, (channel, value) in enumerate(writes)
        ))

    # ── Delete ────────────────────────────────────────────────────────────

    async def adelete_thread(self, thread_id: str) -> None:
        await self._cache.session.destroy_thread(thread_id)

    # ── Sync stubs (not supported) ────────────────────────────────────────

    def get_tuple(self, config: RunnableConfig) -> Optional[CheckpointTuple]:  # type: ignore[override]
        raise RuntimeError("BetterDBSaver is async-only. Use aget_tuple().")

    def list(self, config: Any, **kwargs: Any) -> Any:  # type: ignore[override]
        raise RuntimeError("BetterDBSaver is async-only. Use alist().")

    def put(self, *args: Any, **kwargs: Any) -> Any:  # type: ignore[override]
        raise RuntimeError("BetterDBSaver is async-only. Use aput().")

    def put_writes(self, *args: Any, **kwargs: Any) -> None:  # type: ignore[override]
        raise RuntimeError("BetterDBSaver is async-only. Use aput_writes().")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _extract_pending_writes(
    all_fields: dict[str, str],
    checkpoint_id: str,
) -> list[tuple[str, str, Any]]:
    """Reconstruct pending writes from session fields.

    Key format: writes:{encoded_ckpt_id}|{encoded_task_id}|{encoded_channel}|{idx}
    All components are URL-encoded; literal ``|`` inside values appears as ``%7C``.
    """
    prefix = f"writes:{quote(checkpoint_id, safe='')}|"
    items: list[tuple[int, tuple[str, str, Any]]] = []

    for field, raw_value in all_fields.items():
        if not field.startswith(prefix):
            continue
        rest = field[len(prefix):]
        parts = rest.split("|")
        if len(parts) != 3:
            continue
        task_id = unquote(parts[0])
        channel = unquote(parts[1])
        try:
            idx = int(parts[2])
            value = json.loads(raw_value)
            items.append((idx, (task_id, channel, value)))
        except (ValueError, json.JSONDecodeError):
            pass

    items.sort(key=lambda x: x[0])
    return [write for _, write in items]


def _dict_to_tuple(data: dict[str, Any]) -> Any:
    """Convert a stored dict back to a CheckpointTuple."""
    try:
        return CheckpointTuple(
            config=data.get("config"),
            checkpoint=data.get("checkpoint"),
            metadata=data.get("metadata"),
            parent_config=data.get("parent_config"),
            pending_writes=data.get("pending_writes"),
        )
    except Exception:
        # Fallback: return as-is if CheckpointTuple constructor doesn't match
        return data
