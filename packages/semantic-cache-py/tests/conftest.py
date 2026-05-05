"""Shared test fixtures for betterdb-semantic-cache tests."""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from betterdb_semantic_cache.telemetry import SemanticCacheMetrics, Telemetry


def _noop_span() -> MagicMock:
    span = MagicMock()
    span.__enter__ = MagicMock(return_value=span)
    span.__exit__ = MagicMock(return_value=False)
    span.set_attribute = MagicMock()
    span.set_attributes = MagicMock()
    span.set_status = MagicMock()
    span.record_exception = MagicMock()
    return span


def make_telemetry() -> Telemetry:
    """Return a Telemetry instance with all metrics mocked."""
    tracer = MagicMock()
    tracer.start_as_current_span = MagicMock(return_value=_noop_span())

    def _counter() -> MagicMock:
        m = MagicMock()
        m.labels = MagicMock(return_value=MagicMock(inc=MagicMock()))
        return m

    def _histogram() -> MagicMock:
        m = MagicMock()
        m.labels = MagicMock(return_value=MagicMock(observe=MagicMock()))
        return m

    metrics = SemanticCacheMetrics(
        requests_total=_counter(),
        similarity_score=_histogram(),
        operation_duration=_histogram(),
        embedding_duration=_histogram(),
        cost_saved_total=_counter(),
        embedding_cache_total=_counter(),
        stale_model_evictions=_counter(),
        config_refresh_failed=_counter(),
        discovery_write_failed=_counter(),
    )
    return Telemetry(tracer=tracer, metrics=metrics)


def _ft_info_response(dim: int = 2, has_binary_refs: bool = True) -> list:
    """Build a minimal FT.INFO-style response."""
    attrs = [["identifier", "embedding", "type", "VECTOR", "index", ["dimensions", str(dim)]]]
    if has_binary_refs:
        attrs.append(["identifier", "binary_refs"])
    return ["attributes", attrs]


def _ft_search_hit(key: str, fields: dict[str, str]) -> list:
    """Build a minimal FT.SEARCH response with one result."""
    flat_fields = []
    for k, v in fields.items():
        flat_fields.extend([k, v])
    return ["1", key, flat_fields]


def _ft_search_miss() -> list:
    return ["0"]


def make_client(
    *,
    search_result: dict | None = None,
    ft_info_dim: int = 2,
) -> MagicMock:
    """Return an async mock that behaves like a valkey.asyncio.Valkey client."""
    client = MagicMock()
    client.delete = AsyncMock(return_value=1)
    client.expire = AsyncMock(return_value=1)
    client.hincrby = AsyncMock(return_value=1)
    client.hget = AsyncMock(return_value=None)
    client.hgetall = AsyncMock(return_value={})
    client.hset = AsyncMock(return_value=1)
    client.scan = AsyncMock(return_value=(0, []))
    client.get = AsyncMock(return_value=None)
    client.set = AsyncMock(return_value=True)
    client.zrange = AsyncMock(return_value=[])
    client.zadd = AsyncMock(return_value=1)
    client.zremrangebyscore = AsyncMock(return_value=0)
    client.zremrangebyrank = AsyncMock(return_value=0)

    def _execute_command(*args: Any) -> Any:
        cmd = args[0] if args else ""
        if cmd == "FT.INFO":
            return _ft_info_response(ft_info_dim)
        if cmd == "FT.CREATE":
            return "OK"
        if cmd == "FT.DROPINDEX":
            return "OK"
        if cmd == "FT.SEARCH":
            if search_result:
                fields = {**search_result.get("fields", {}), "__score": "0.01"}
                return _ft_search_hit(search_result["key"], fields)
            return _ft_search_miss()
        return None

    client.execute_command = AsyncMock(side_effect=_execute_command)

    pipe = MagicMock()
    pipe.hincrby = MagicMock()
    pipe.expire = MagicMock()
    pipe.zadd = MagicMock()
    pipe.zremrangebyscore = MagicMock()
    pipe.zremrangebyrank = MagicMock()
    pipe.execute_command = MagicMock()
    pipe.execute = AsyncMock(return_value=[])
    client.pipeline = MagicMock(return_value=pipe)

    return client


@pytest.fixture
def telemetry() -> Telemetry:
    return make_telemetry()


@pytest.fixture
def valkey_client() -> MagicMock:
    return make_client()
