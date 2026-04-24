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
    """Valkey-like mock that remembers ``GET``/``SET``/``DELETE`` for a single process.

    ``make_client()`` always returns ``None`` from ``get``; adapter tests that run
    ``store``/``store_multipart`` then ``check`` need values to round-trip like a
    real server.
    """
    storage: dict[str, str] = {}

    def _norm_key(key: object) -> str:
        if isinstance(key, bytes):
            return key.decode()
        return str(key)

    async def _get(key: object) -> str | None:
        return storage.get(_norm_key(key))

    async def _set(key: object, value: object, ex: int | None = None) -> bool:
        if isinstance(value, bytes):
            storage[_norm_key(key)] = value.decode("utf-8")
        else:
            storage[_norm_key(key)] = str(value)
        return True

    async def _delete(key: object) -> int:
        k = _norm_key(key)
        if k in storage:
            del storage[k]
            return 1
        return 0

    client = MagicMock()
    client.get = AsyncMock(side_effect=_get)
    client.set = AsyncMock(side_effect=_set)
    client.delete = AsyncMock(side_effect=_delete)
    client.expire = AsyncMock(return_value=1)
    client.hincrby = AsyncMock(return_value=1)
    client.hgetall = AsyncMock(return_value={})
    client.hset = AsyncMock(return_value=1)
    client.scan = AsyncMock(return_value=(0, []))

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


@pytest.fixture
def telemetry() -> Telemetry:
    return make_telemetry()


@pytest.fixture
def valkey_client() -> MagicMock:
    return make_client()
