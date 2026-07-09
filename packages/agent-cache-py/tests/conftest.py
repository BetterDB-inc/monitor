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
<<<<<<< HEAD
    """Async mock valkey client backed by in-memory state.

    Canonical shared helper (see PR #149 / #131 coordination): models direct
    kv + hash commands *and* a stateful pipeline so tests that rely on either
    surface pass against the same backing store.
    """
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

    # --- stateful pipeline (superset of PR #131's helper) ---------------------
    # llm_cache calls client.pipeline(transaction=False), queues commands, then
    # awaits execute(). Apply queued ops against the same kv/hashes store so
    # pipeline-based writes (e.g. _inc_stats) actually persist and can be asserted.
    def _make_pipeline(*_args, **_kwargs):
        queued: list[tuple[str, tuple]] = []
        pipe = MagicMock()

        def _queue(op):
            def _fn(*a):
                queued.append((op, a))
                return pipe
            return _fn

        pipe.get = _queue("get")
        pipe.set = _queue("set")
        pipe.delete = _queue("delete")
        pipe.expire = _queue("expire")
        pipe.hincrby = _queue("hincrby")
        pipe.hset = _queue("hset")

        async def _execute():
            results: list = []
            for op, a in queued:
                if op == "get":
                    results.append(kv.get(a[0]))
                elif op == "set":
                    kv[a[0]] = a[1]
                    results.append(True)
                elif op == "delete":
                    results.append(await _delete(*a))
                elif op == "hincrby":
                    results.append(await _hincrby(*a))
                elif op == "hset":
                    results.append(await _hset(*a))
                else:  # expire / unknown -> no-op ack
                    results.append(1)
            queued.clear()
            return results

        pipe.execute = AsyncMock(side_effect=_execute)
        pipe.__aenter__ = AsyncMock(return_value=pipe)
        pipe.__aexit__ = AsyncMock(return_value=False)
        return pipe

    client.pipeline = MagicMock(side_effect=_make_pipeline)
=======
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

>>>>>>> c5fa266 (feat(agent-cache-py): add Pydantic AI adapter)
    return client


@pytest.fixture
def telemetry() -> Telemetry:
    return make_telemetry()


@pytest.fixture
def valkey_client() -> MagicMock:
    return make_client()
