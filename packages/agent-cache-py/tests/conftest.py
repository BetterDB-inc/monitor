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


@pytest.fixture
def telemetry() -> Telemetry:
    return make_telemetry()


@pytest.fixture
def valkey_client() -> MagicMock:
    return make_client()
