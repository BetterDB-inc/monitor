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


# ─── get_all ──────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_all_returns_all_fields_for_thread():
    store, client = _make_store()
    client.scan = AsyncMock(return_value=(
        0,
        [b"test:session:thread-1:field_a", b"test:session:thread-1:field_b"],
    ))
    pipe = client.pipeline()
    pipe.execute = AsyncMock(return_value=[b"val_a", b"val_b"])

    result = await store.get_all("thread-1")

    assert result == {"field_a": "val_a", "field_b": "val_b"}


@pytest.mark.asyncio
async def test_get_all_returns_empty_dict_when_no_keys():
    store, client = _make_store()
    client.scan = AsyncMock(return_value=(0, []))

    result = await store.get_all("thread-1")

    assert result == {}


@pytest.mark.asyncio
async def test_get_all_skips_none_values():
    store, client = _make_store()
    client.scan = AsyncMock(return_value=(
        0,
        [b"test:session:thread-1:field_a", b"test:session:thread-1:field_b"],
    ))
    pipe = client.pipeline()
    pipe.execute = AsyncMock(return_value=[b"val_a", None])

    result = await store.get_all("thread-1")

    assert result == {"field_a": "val_a"}


@pytest.mark.asyncio
async def test_get_all_refreshes_ttl_when_configured():
    store, client = _make_store(default_ttl=300)
    client.scan = AsyncMock(return_value=(
        0,
        [b"test:session:thread-1:field_a"],
    ))
    pipe = client.pipeline()
    pipe.execute = AsyncMock(return_value=[b"val_a"])

    await store.get_all("thread-1")

    # TTL refresh uses a second pipeline — both pipelines share the mock
    pipe.expire.assert_called()


@pytest.mark.asyncio
async def test_get_all_does_not_refresh_ttl_when_not_configured():
    store, client = _make_store()  # no TTL
    client.scan = AsyncMock(return_value=(
        0,
        [b"test:session:thread-1:field_a"],
    ))
    pipe = client.pipeline()
    pipe.execute = AsyncMock(return_value=[b"val_a"])

    await store.get_all("thread-1")

    pipe.expire.assert_not_called()


# ─── scan_fields_by_prefix ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_scan_fields_by_prefix_returns_matching_fields():
    store, client = _make_store()
    client.scan = AsyncMock(return_value=(
        0,
        [b"test:session:thread-1:checkpoint_ts:1000", b"test:session:thread-1:checkpoint_ts:2000"],
    ))
    pipe = client.pipeline()
    pipe.execute = AsyncMock(return_value=[b"data_1", b"data_2"])

    result = await store.scan_fields_by_prefix("thread-1", "checkpoint_ts:")

    assert result == {"checkpoint_ts:1000": "data_1", "checkpoint_ts:2000": "data_2"}


@pytest.mark.asyncio
async def test_scan_fields_by_prefix_returns_empty_when_no_match():
    store, client = _make_store()
    client.scan = AsyncMock(return_value=(0, []))

    result = await store.scan_fields_by_prefix("thread-1", "nonexistent:")

    assert result == {}


@pytest.mark.asyncio
async def test_scan_fields_by_prefix_skips_none_values():
    store, client = _make_store()
    client.scan = AsyncMock(return_value=(
        0,
        [b"test:session:thread-1:msg:1", b"test:session:thread-1:msg:2"],
    ))
    pipe = client.pipeline()
    pipe.execute = AsyncMock(return_value=[b"content", None])

    result = await store.scan_fields_by_prefix("thread-1", "msg:")

    assert result == {"msg:1": "content"}


@pytest.mark.asyncio
async def test_scan_fields_by_prefix_does_not_refresh_ttl():
    """scan_fields_by_prefix is a read-only scan — it must not call expire."""
    store, client = _make_store(default_ttl=300)
    client.scan = AsyncMock(return_value=(
        0,
        [b"test:session:thread-1:msg:1"],
    ))
    pipe = client.pipeline()
    pipe.execute = AsyncMock(return_value=[b"content"])

    await store.scan_fields_by_prefix("thread-1", "msg:")

    pipe.expire.assert_not_called()


# ─── destroy_thread ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_destroy_thread_deletes_all_keys_and_returns_count():
    store, client = _make_store()
    client.scan = AsyncMock(return_value=(
        0,
        [b"test:session:thread-1:field_a", b"test:session:thread-1:field_b"],
    ))
    pipe = client.pipeline()
    pipe.execute = AsyncMock(return_value=[1, 1])

    deleted = await store.destroy_thread("thread-1")

    assert deleted == 2
    pipe.delete.assert_any_call("test:session:thread-1:field_a")
    pipe.delete.assert_any_call("test:session:thread-1:field_b")


@pytest.mark.asyncio
async def test_destroy_thread_returns_zero_when_no_keys():
    store, client = _make_store()
    client.scan = AsyncMock(return_value=(0, []))

    deleted = await store.destroy_thread("thread-1")

    assert deleted == 0


@pytest.mark.asyncio
async def test_destroy_thread_removes_from_tracker_and_decrements_active_sessions():
    store, client = _make_store()
    # Seed the tracker so the thread is known
    store._tracker.add("thread-1")
    client.scan = AsyncMock(return_value=(0, [b"test:session:thread-1:field_a"]))
    pipe = client.pipeline()
    pipe.execute = AsyncMock(return_value=[1])
    gauge = store._telemetry.metrics.active_sessions.labels(store._name)

    await store.destroy_thread("thread-1")

    assert store._tracker.remove("thread-1") is False  # already removed
    gauge.dec.assert_called()


@pytest.mark.asyncio
async def test_destroy_thread_does_not_decrement_gauge_for_unknown_thread():
    """destroy_thread on a thread not in the tracker must not touch the gauge."""
    store, client = _make_store()
    client.scan = AsyncMock(return_value=(0, []))
    gauge = store._telemetry.metrics.active_sessions.labels(store._name)

    await store.destroy_thread("unknown-thread")

    gauge.dec.assert_not_called()


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
