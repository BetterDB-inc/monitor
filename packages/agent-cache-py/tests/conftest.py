"""Shared test fixtures."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from betterdb_agent_cache.telemetry import AgentCacheMetrics, Telemetry


def _noop_span():
    """Return a context-manager span that does nothing."""
    span = MagicMock()
    span.__enter__ = MagicMock(return_value=span)
    span.__exit__ = MagicMock(return_value=False)
    span.set_attribute = MagicMock()
    span.record_exception = MagicMock()
    return span


def make_telemetry() -> Telemetry:
    tracer = MagicMock()
    tracer.start_as_current_span = MagicMock(return_value=_noop_span())

    def _counter():
        m = MagicMock()
        m.labels = MagicMock(return_value=MagicMock(inc=MagicMock()))
        return m

    def _histogram():
        m = MagicMock()
        m.labels = MagicMock(return_value=MagicMock(observe=MagicMock()))
        return m

    def _gauge():
        m = MagicMock()
        m.labels = MagicMock(return_value=MagicMock(inc=MagicMock(), dec=MagicMock(), set=MagicMock()))
        return m

    metrics = AgentCacheMetrics(
        requests_total=_counter(),
        operation_duration=_histogram(),
        cost_saved=_counter(),
        stored_bytes=_counter(),
        active_sessions=_gauge(),
        config_refresh_failed=_counter(),
        discovery_write_failed=_counter(),
    )
    return Telemetry(tracer=tracer, metrics=metrics)


def make_client() -> MagicMock:
    """Return an async mock that behaves like a valkey.asyncio.Valkey client."""
    client = MagicMock()
    client.get = AsyncMock(return_value=None)
    client.set = AsyncMock(return_value=True)
    client.delete = AsyncMock(return_value=1)
    client.expire = AsyncMock(return_value=1)
    client.hincrby = AsyncMock(return_value=1)
    client.hget = AsyncMock(return_value=None)
    client.hgetall = AsyncMock(return_value={})
    client.hset = AsyncMock(return_value=1)
    client.scan = AsyncMock(return_value=(0, []))

    # pipeline() returns a mock that queues commands and executes them
    pipe = MagicMock()
    pipe.get = MagicMock()
    pipe.set = MagicMock()
    pipe.delete = MagicMock()
    pipe.expire = MagicMock()
    pipe.hincrby = MagicMock()
    pipe.execute = AsyncMock(return_value=[])
    pipe.__aenter__ = AsyncMock(return_value=pipe)
    pipe.__aexit__ = AsyncMock(return_value=False)
    client.pipeline = MagicMock(return_value=pipe)

    return client


def make_persisting_valkey_client() -> MagicMock:
    """Return an async mock valkey client backed by in-memory state."""
    kv: dict[str, str] = {}
    hashes: dict[str, dict[str, str]] = {}

    client = make_client()

    async def _get(key: str):
        return kv.get(key)

    async def _set(key: str, value: str, ex=None):  # noqa: ANN001
        _ = ex
        kv[key] = value
        return True

    async def _delete(*keys: str):
        deleted = 0
        for key in keys:
            if key in kv:
                del kv[key]
                deleted += 1
            if key in hashes:
                del hashes[key]
                deleted += 1
        return deleted

    async def _hget(name: str, key: str):
        return hashes.get(name, {}).get(key)

    async def _hset(name: str, key: str, value: str):
        bucket = hashes.setdefault(name, {})
        is_new = key not in bucket
        bucket[key] = value
        return 1 if is_new else 0

    async def _hgetall(name: str):
        return dict(hashes.get(name, {}))

    async def _hincrby(name: str, key: str, amount: int):
        bucket = hashes.setdefault(name, {})
        current = int(bucket.get(key, "0"))
        updated = current + amount
        bucket[key] = str(updated)
        return updated

    async def _scan(cursor=0, match=None, count=None):  # noqa: ANN001
        _ = (cursor, match, count)
        return (0, [])

    client.get = AsyncMock(side_effect=_get)
    client.set = AsyncMock(side_effect=_set)
    client.delete = AsyncMock(side_effect=_delete)
    client.hget = AsyncMock(side_effect=_hget)
    client.hset = AsyncMock(side_effect=_hset)
    client.hgetall = AsyncMock(side_effect=_hgetall)
    client.hincrby = AsyncMock(side_effect=_hincrby)
    client.scan = AsyncMock(side_effect=_scan)
    client.expire = AsyncMock(return_value=1)

    return client


@pytest.fixture
def telemetry() -> Telemetry:
    return make_telemetry()


@pytest.fixture
def valkey_client() -> MagicMock:
    return make_client()
