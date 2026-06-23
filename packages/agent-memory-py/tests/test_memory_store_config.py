from __future__ import annotations

import asyncio
from typing import Any

from betterdb_agent_memory import MemoryStore
from betterdb_agent_memory.types import MemoryConfigRefreshConfig, RecallWeights

from .conftest import fake_client, fake_embed, flat_fields, now_ms

DEFAULT_WEIGHTS = RecallWeights(similarity=0.6, recency=0.25, importance=0.15)


def config_client(fields: dict[str, str], others: Any = None) -> Any:
    def handler(command: str, *args: Any) -> Any:
        if command == "HGETALL":
            return flat_fields(fields)
        return others(command) if others else "OK"

    return fake_client(handler)


def recall_hit(distance: float) -> list[Any]:
    now = now_ms()
    fields = {
        "__score": str(distance),
        "content": "c",
        "importance": "0.5",
        "created_at": str(now),
        "last_accessed_at": str(now),
        "access_count": "0",
    }
    return ["1", "mem:mem:a", flat_fields(fields)]


def test_current_config_reflects_constructor_defaults_before_refresh() -> None:
    store = MemoryStore(client=fake_client(), name="mem", embed_fn=fake_embed(8))
    snap = store.current_config()
    assert snap.threshold == 0.25
    assert snap.weights == DEFAULT_WEIGHTS
    assert snap.half_life_seconds == 604800
    assert snap.max_items_per_scope is None


async def test_applies_recall_threshold() -> None:
    store = MemoryStore(
        client=config_client({"recall.threshold": "0.5"}), name="mem", embed_fn=fake_embed(8)
    )
    await store.refresh_config()
    assert store.current_config().threshold == 0.5


async def test_applies_recall_weights() -> None:
    store = MemoryStore(
        client=config_client(
            {
                "recall.weights.similarity": "0.2",
                "recall.weights.recency": "0.7",
                "recall.weights.importance": "0.1",
            }
        ),
        name="mem",
        embed_fn=fake_embed(8),
    )
    await store.refresh_config()
    assert store.current_config().weights == RecallWeights(
        similarity=0.2, recency=0.7, importance=0.1
    )


async def test_applies_half_life_seconds_and_max_items_per_scope() -> None:
    store = MemoryStore(
        client=config_client({"recall.halfLifeSeconds": "3600", "maxItemsPerScope": "100"}),
        name="mem",
        embed_fn=fake_embed(8),
    )
    await store.refresh_config()
    assert store.current_config().half_life_seconds == 3600
    assert store.current_config().max_items_per_scope == 100


async def test_leaves_unspecified_tunables_at_constructor_values() -> None:
    store = MemoryStore(
        client=config_client({"recall.threshold": "0.5"}),
        name="mem",
        embed_fn=fake_embed(8),
        weights=RecallWeights(similarity=0.5, recency=0.3, importance=0.2),
    )
    await store.refresh_config()
    assert store.current_config().threshold == 0.5
    assert store.current_config().weights == RecallWeights(
        similarity=0.5, recency=0.3, importance=0.2
    )


async def test_reverts_tunable_to_constructor_value_when_field_disappears() -> None:
    state = {"present": True}

    def handler(command: str, *args: Any) -> Any:
        if command == "HGETALL":
            return flat_fields({"recall.threshold": "0.9"}) if state["present"] else []
        return "OK"

    store = MemoryStore(client=fake_client(handler), name="mem", embed_fn=fake_embed(8))

    await store.refresh_config()
    assert store.current_config().threshold == 0.9

    state["present"] = False
    await store.refresh_config()
    assert store.current_config().threshold == 0.25


async def test_ignores_invalid_values_and_keeps_constructor_defaults() -> None:
    store = MemoryStore(
        client=config_client(
            {
                "recall.threshold": "5",
                "recall.weights.recency": "not-a-number",
                "recall.halfLifeSeconds": "-1",
                "maxItemsPerScope": "0",
            }
        ),
        name="mem",
        embed_fn=fake_embed(8),
    )
    await store.refresh_config()
    snap = store.current_config()
    assert snap.threshold == 0.25
    assert snap.weights == DEFAULT_WEIGHTS
    assert snap.half_life_seconds == 604800
    assert snap.max_items_per_scope is None


async def test_rejects_all_zero_weight_vector_and_keeps_constructor_weights() -> None:
    store = MemoryStore(
        client=config_client(
            {
                "recall.weights.similarity": "0",
                "recall.weights.recency": "0",
                "recall.weights.importance": "0",
            }
        ),
        name="mem",
        embed_fn=fake_embed(8),
    )
    await store.refresh_config()
    assert store.current_config().weights == DEFAULT_WEIGHTS


async def test_preserves_live_weight_components_when_only_subset_written() -> None:
    state: dict[str, dict[str, str]] = {
        "hash": {
            "recall.weights.similarity": "0.2",
            "recall.weights.recency": "0.7",
            "recall.weights.importance": "0.1",
        }
    }

    def handler(command: str, *args: Any) -> Any:
        return flat_fields(state["hash"]) if command == "HGETALL" else "OK"

    store = MemoryStore(client=fake_client(handler), name="mem", embed_fn=fake_embed(8))

    await store.refresh_config()
    assert store.current_config().weights == RecallWeights(
        similarity=0.2, recency=0.7, importance=0.1
    )

    state["hash"] = {"recall.weights.similarity": "0.5"}
    await store.refresh_config()
    assert store.current_config().weights == RecallWeights(
        similarity=0.5, recency=0.7, importance=0.1
    )


async def test_live_applies_looser_threshold_to_recall() -> None:
    def handler(command: str, *args: Any) -> Any:
        if command == "HGETALL":
            return flat_fields({"recall.threshold": "0.5"})
        if command == "FT.SEARCH":
            return recall_hit(0.4)
        return "OK"

    store = MemoryStore(client=fake_client(handler), name="mem", embed_fn=fake_embed(8))

    assert len(await store.recall("q", k=1)) == 0
    await store.refresh_config()
    assert len(await store.recall("q", k=1)) == 1


async def test_does_not_poll_config_hash_when_refresh_not_enabled() -> None:
    client = fake_client()
    MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))
    await asyncio.sleep(0)
    assert not any(c[0] == "HGETALL" for c in client.calls)


async def test_reads_immediately_and_on_interval_and_stops_on_close() -> None:
    client = config_client({"recall.threshold": "0.4"})
    store = MemoryStore(
        client=client,
        name="mem",
        embed_fn=fake_embed(8),
        config_refresh=MemoryConfigRefreshConfig(interval_ms=1000),
    )

    await asyncio.sleep(0.05)
    initial = len(client.calls_for("HGETALL"))
    assert initial >= 1

    await asyncio.sleep(1.1)
    after_tick = len(client.calls_for("HGETALL"))
    assert after_tick > initial

    await store.close()
    await asyncio.sleep(1.1)
    after_close = len(client.calls_for("HGETALL"))
    assert after_close == after_tick


async def test_never_throws_when_config_read_fails() -> None:
    def handler(command: str, *args: Any) -> Any:
        if command == "HGETALL":
            raise RuntimeError("hgetall boom")
        return "OK"

    store = MemoryStore(client=fake_client(handler), name="mem", embed_fn=fake_embed(8))

    assert await store.refresh_config() is None
    assert store.current_config().threshold == 0.25
