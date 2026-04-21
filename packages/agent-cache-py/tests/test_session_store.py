"""Unit tests for SessionStore."""
from __future__ import annotations

from unittest.mock import AsyncMock, call

import pytest

from betterdb_agent_cache.errors import ValkeyCommandError
from betterdb_agent_cache.tiers.session_store import SessionStore, SessionStoreConfig, SessionTracker

from .conftest import make_client, make_telemetry


def _make_store(
    default_ttl: int | None = None,
    tier_ttl: int | None = None,
) -> tuple[SessionStore, object]:
    client = make_client()
    config = SessionStoreConfig(
        client=client,
        name="test",
        default_ttl=default_ttl,
        tier_ttl=tier_ttl,
        telemetry=make_telemetry(),
        stats_key="test:__stats",
    )
    return SessionStore(config), client


# ─── SessionTracker ───────────────────────────────────────────────────────────

def test_tracker_new_thread():
    tracker = SessionTracker()
    is_new, evicted = tracker.add("thread-1")
    assert is_new is True
    assert evicted is None


def test_tracker_existing_thread_not_new():
    tracker = SessionTracker()
    tracker.add("thread-1")
    is_new, evicted = tracker.add("thread-1")
    assert is_new is False


def test_tracker_evicts_oldest_at_capacity():
    tracker = SessionTracker(max_size=2)
    tracker.add("thread-1")
    tracker.add("thread-2")
    is_new, evicted = tracker.add("thread-3")
    assert is_new is True
    assert evicted in ("thread-1", "thread-2")
    assert len(tracker._seen) == 2


def test_tracker_remove():
    tracker = SessionTracker()
    tracker.add("thread-1")
    assert tracker.remove("thread-1") is True
    assert tracker.remove("thread-1") is False


def test_tracker_reset():
    tracker = SessionTracker()
    tracker.add("thread-1")
    tracker.add("thread-2")
    count = tracker.reset()
    assert count == 2
    assert len(tracker._seen) == 0


# ─── get ──────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_returns_none_when_absent():
    store, client = _make_store()
    client.get = AsyncMock(return_value=None)

    result = await store.get("thread-1", "state")

    assert result is None


@pytest.mark.asyncio
async def test_get_returns_value():
    store, client = _make_store()
    client.get = AsyncMock(return_value=b"my_state")

    result = await store.get("thread-1", "state")

    assert result == "my_state"


@pytest.mark.asyncio
async def test_get_refreshes_ttl_on_hit():
    store, client = _make_store(default_ttl=3600)
    client.get = AsyncMock(return_value=b"value")

    await store.get("thread-1", "state")

    client.expire.assert_called_once_with("test:session:thread-1:state", 3600)


@pytest.mark.asyncio
async def test_get_no_ttl_refresh_when_no_ttl():
    store, client = _make_store()  # no TTL configured
    client.get = AsyncMock(return_value=b"value")

    await store.get("thread-1", "state")

    client.expire.assert_not_called()


@pytest.mark.asyncio
async def test_get_raises_on_valkey_error():
    store, client = _make_store()
    client.get = AsyncMock(side_effect=Exception("timeout"))

    with pytest.raises(ValkeyCommandError, match="GET"):
        await store.get("thread-1", "state")


# ─── set ──────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_set_stores_value():
    store, client = _make_store()

    await store.set("thread-1", "state", "some_value")

    client.set.assert_called_once_with("test:session:thread-1:state", "some_value")


@pytest.mark.asyncio
async def test_set_with_ttl():
    store, client = _make_store(default_ttl=1800)

    await store.set("thread-1", "state", "value")

    client.set.assert_called_once_with("test:session:thread-1:state", "value", ex=1800)


@pytest.mark.asyncio
async def test_set_per_call_ttl_overrides_default():
    store, client = _make_store(default_ttl=1800)

    await store.set("thread-1", "state", "value", ttl=60)

    client.set.assert_called_once_with("test:session:thread-1:state", "value", ex=60)


@pytest.mark.asyncio
async def test_set_increments_active_sessions_for_new_thread():
    store, client = _make_store()
    gauge = store._telemetry.metrics.active_sessions.labels(store._name)

    await store.set("thread-new", "state", "v")

    gauge.inc.assert_called()


# ─── delete ───────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_delete_returns_true_when_key_existed():
    store, client = _make_store()
    client.delete = AsyncMock(return_value=1)

    result = await store.delete("thread-1", "state")

    assert result is True


@pytest.mark.asyncio
async def test_delete_returns_false_when_key_absent():
    store, client = _make_store()
    client.delete = AsyncMock(return_value=0)

    result = await store.delete("thread-1", "state")

    assert result is False


# ─── touch ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_touch_no_op_without_ttl():
    store, client = _make_store()  # no TTL

    await store.touch("thread-1")

    client.scan.assert_not_called()


@pytest.mark.asyncio
async def test_touch_scans_and_expires_keys():
    store, client = _make_store(default_ttl=300)
    client.scan = AsyncMock(return_value=(0, [b"test:session:thread-1:state"]))
    pipe = client.pipeline()
    pipe.execute = AsyncMock(return_value=[1])

    await store.touch("thread-1")

    pipe.expire.assert_called()


# ─── reset_tracker ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_reset_tracker_clears_and_sets_gauge_zero():
    store, _ = _make_store()
    store._tracker.add("t1")
    store._tracker.add("t2")
    gauge = store._telemetry.metrics.active_sessions.labels(store._name)

    store.reset_tracker()

    assert len(store._tracker._seen) == 0
    gauge.set.assert_called_with(0)
