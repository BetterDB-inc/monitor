"""Tests for the LangGraph checkpoint saver adapter."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock
from urllib.parse import quote

import pytest

langgraph = pytest.importorskip("langgraph")

from betterdb_agent_cache.adapters.langgraph import (
    BetterDBSaver,
    _extract_pending_writes,
)


def _make_saver():
    session = MagicMock()
    session.get = AsyncMock(return_value=None)
    session.set = AsyncMock()
    session.get_all = AsyncMock(return_value={})
    session.scan_fields_by_prefix = AsyncMock(return_value={})
    session.destroy_thread = AsyncMock()

    agent_cache = MagicMock()
    agent_cache.session = session
    return BetterDBSaver(cache=agent_cache), agent_cache


def _config(thread_id: str, checkpoint_id: str | None = None) -> dict:
    cfg: dict = {"configurable": {"thread_id": thread_id}}
    if checkpoint_id:
        cfg["configurable"]["checkpoint_id"] = checkpoint_id
    return cfg


def _stored_tuple(checkpoint_id: str = "ckpt-1", ts: str = "2026-04-20T10:00:00Z") -> str:
    return json.dumps({
        "config": {"configurable": {"thread_id": "t1", "checkpoint_id": checkpoint_id}},
        "checkpoint": {"id": checkpoint_id, "ts": ts},
        "metadata": {},
    })


# ─── _extract_pending_writes ──────────────────────────────────────────────────

def test_extract_pending_writes_basic():
    ckpt_id = "ckpt-1"
    fields = {
        f"writes:{quote(ckpt_id, safe='')}|{quote('task-1', safe='')}|{quote('channel', safe='')}|0":
            json.dumps("value1"),
        f"writes:{quote(ckpt_id, safe='')}|{quote('task-1', safe='')}|{quote('channel', safe='')}|1":
            json.dumps("value2"),
    }
    writes = _extract_pending_writes(fields, ckpt_id)
    assert len(writes) == 2
    assert writes[0] == ("task-1", "channel", "value1")
    assert writes[1] == ("task-1", "channel", "value2")


def test_extract_pending_writes_ignores_other_fields():
    fields = {
        "checkpoint:abc": json.dumps({"id": "abc"}),
        f"writes:{quote('other-ckpt', safe='')}|t|c|0": json.dumps("val"),
    }
    writes = _extract_pending_writes(fields, "ckpt-1")
    assert writes == []


def test_extract_pending_writes_sorted_by_idx():
    ckpt_id = "ckpt-1"
    fields = {
        f"writes:{quote(ckpt_id, safe='')}|t|c|2": json.dumps("c"),
        f"writes:{quote(ckpt_id, safe='')}|t|c|0": json.dumps("a"),
        f"writes:{quote(ckpt_id, safe='')}|t|c|1": json.dumps("b"),
    }
    writes = _extract_pending_writes(fields, ckpt_id)
    assert [w[2] for w in writes] == ["a", "b", "c"]


# ─── aget_tuple ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_aget_tuple_returns_none_when_no_thread():
    saver, _ = _make_saver()
    result = await saver.aget_tuple({"configurable": {}})
    assert result is None


@pytest.mark.asyncio
async def test_aget_tuple_returns_none_when_key_absent():
    saver, agent_cache = _make_saver()
    agent_cache.session.get = AsyncMock(return_value=None)

    result = await saver.aget_tuple(_config("t1"))
    assert result is None


@pytest.mark.asyncio
async def test_aget_tuple_reads_latest_pointer():
    saver, agent_cache = _make_saver()
    agent_cache.session.get = AsyncMock(return_value=_stored_tuple())

    result = await saver.aget_tuple(_config("t1"))
    assert result is not None
    assert result.checkpoint["id"] == "ckpt-1"


@pytest.mark.asyncio
async def test_aget_tuple_reads_specific_checkpoint():
    saver, agent_cache = _make_saver()
    agent_cache.session.get = AsyncMock(return_value=_stored_tuple("ckpt-99"))

    result = await saver.aget_tuple(_config("t1", "ckpt-99"))
    assert result.checkpoint["id"] == "ckpt-99"


# ─── aput ─────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_aput_writes_checkpoint_and_latest():
    saver, agent_cache = _make_saver()
    config = _config("t1")
    checkpoint = {"id": "ckpt-new", "ts": "2026-04-20T12:00:00Z"}

    returned = await saver.aput(config, checkpoint, {}, {})

    assert returned["configurable"]["checkpoint_id"] == "ckpt-new"
    assert agent_cache.session.set.call_count == 2
    calls = [c.args[1] for c in agent_cache.session.set.call_args_list]
    assert "checkpoint:ckpt-new" in calls
    assert "__checkpoint_latest" in calls


@pytest.mark.asyncio
async def test_aput_stores_parent_config():
    saver, agent_cache = _make_saver()
    config = _config("t1", "ckpt-parent")
    checkpoint = {"id": "ckpt-child", "ts": "2026-04-20T12:00:00Z"}

    await saver.aput(config, checkpoint, {}, {})

    stored_payload = json.loads(agent_cache.session.set.call_args_list[0].args[2])
    assert stored_payload["config"]["configurable"]["checkpoint_id"] == "ckpt-child"
    assert stored_payload["parent_config"]["configurable"]["checkpoint_id"] == "ckpt-parent"


@pytest.mark.asyncio
async def test_aput_raises_without_thread_id():
    saver, _ = _make_saver()
    from betterdb_agent_cache.errors import AgentCacheUsageError
    with pytest.raises(AgentCacheUsageError):
        await saver.aput({"configurable": {}}, {"id": "x"}, {}, {})


# ─── aput_writes ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_aput_writes_stores_all_writes():
    saver, agent_cache = _make_saver()
    config = _config("t1", "ckpt-1")

    await saver.aput_writes(config, [("channel_a", "val_a"), ("channel_b", "val_b")], "task-1")

    assert agent_cache.session.set.call_count == 2


@pytest.mark.asyncio
async def test_aput_writes_raises_without_checkpoint_id():
    saver, _ = _make_saver()
    from betterdb_agent_cache.errors import AgentCacheUsageError
    with pytest.raises(AgentCacheUsageError):
        await saver.aput_writes({"configurable": {"thread_id": "t1"}}, [], "task-1")


# ─── alist ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_alist_fast_path_limit_1():
    saver, agent_cache = _make_saver()
    agent_cache.session.get = AsyncMock(return_value=_stored_tuple())

    results = []
    async for t in saver.alist(_config("t1"), limit=1):
        results.append(t)

    assert len(results) == 1
    assert results[0].checkpoint["id"] == "ckpt-1"


@pytest.mark.asyncio
async def test_alist_returns_empty_for_no_thread():
    saver, _ = _make_saver()
    results = []
    async for t in saver.alist({"configurable": {}}, limit=5):
        results.append(t)
    assert results == []


@pytest.mark.asyncio
async def test_alist_general_path_sorts_by_timestamp():
    saver, agent_cache = _make_saver()
    agent_cache.session.get_all = AsyncMock(return_value={
        "checkpoint:ckpt-old": _stored_tuple("ckpt-old", "2026-04-01T00:00:00Z"),
        "checkpoint:ckpt-new": _stored_tuple("ckpt-new", "2026-04-20T00:00:00Z"),
    })

    results = []
    async for t in saver.alist(_config("t1")):
        results.append(t)

    assert results[0].checkpoint["id"] == "ckpt-new"
    assert results[1].checkpoint["id"] == "ckpt-old"


# ─── sync stubs ───────────────────────────────────────────────────────────────

def test_sync_get_tuple_raises():
    saver, _ = _make_saver()
    with pytest.raises(RuntimeError, match="async"):
        saver.get_tuple(_config("t1"))


def test_sync_put_raises():
    saver, _ = _make_saver()
    with pytest.raises(RuntimeError, match="async"):
        saver.put()
