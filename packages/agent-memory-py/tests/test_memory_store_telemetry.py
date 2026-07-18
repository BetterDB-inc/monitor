from __future__ import annotations

import re
from typing import Any

from betterdb_agent_memory import MemoryStore, MemoryTelemetryOptions
from prometheus_client import CollectorRegistry, generate_latest

from .conftest import fake_client, fake_embed, ft_reply, now_ms


def metrics_text(registry: CollectorRegistry) -> str:
    return generate_latest(registry).decode()


def recall_hit(distance: float) -> list[Any]:
    now = now_ms()
    flat: list[str] = []
    for field, value in {
        "__score": str(distance),
        "content": "c",
        "importance": "0.5",
        "created_at": str(now),
        "last_accessed_at": str(now),
        "access_count": "0",
    }.items():
        flat.extend([field, value])
    return ["1", "mem:mem:a", flat]


def eviction_fields(importance: float, last_accessed_at: int) -> dict[str, str]:
    return {"importance": str(importance), "last_accessed_at": str(last_accessed_at)}


def consolidate_hit(id: str) -> tuple[str, dict[str, str]]:
    created = now_ms() - 100000 * 1000
    return (
        f"mem:mem:{id}",
        {
            "content": f"c-{id}",
            "importance": "0.2",
            "created_at": str(created),
            "last_accessed_at": str(created),
            "access_count": "0",
        },
    )


async def make_summary(_items: list[Any]) -> str:
    return "summary"


async def test_counts_embedding_calls_and_bumps_items_gauge_on_remember() -> None:
    registry = CollectorRegistry()
    store = MemoryStore(
        client=fake_client(),
        name="mem",
        embed_fn=fake_embed(8),
        telemetry=MemoryTelemetryOptions(registry=registry),
    )

    await store.remember("hi")

    text = metrics_text(registry)
    assert re.search(r'agent_memory_embedding_calls_total\{store_name="mem"\} 1', text)
    assert re.search(r'agent_memory_items\{store_name="mem"\} 1', text)


async def test_records_a_recall_hit() -> None:
    registry = CollectorRegistry()
    client = fake_client(lambda command, *args: recall_hit(0.1) if command == "FT.SEARCH" else "OK")
    store = MemoryStore(
        client=client,
        name="mem",
        embed_fn=fake_embed(8),
        telemetry=MemoryTelemetryOptions(registry=registry),
    )

    await store.recall("q", k=1)

    text = metrics_text(registry)
    assert re.search(r'agent_memory_recall_total\{store_name="mem"\} 1', text)
    assert re.search(r'agent_memory_recall_hits_total\{store_name="mem"\} 1', text)
    assert re.search(r'agent_memory_recall_latency_seconds_count\{store_name="mem"\} 1', text)


async def test_records_an_empty_recall() -> None:
    registry = CollectorRegistry()
    client = fake_client(lambda command, *args: ["0"] if command == "FT.SEARCH" else "OK")
    store = MemoryStore(
        client=client,
        name="mem",
        embed_fn=fake_embed(8),
        telemetry=MemoryTelemetryOptions(registry=registry),
    )

    await store.recall("q", k=1)

    text = metrics_text(registry)
    assert re.search(r'agent_memory_recall_empty_total\{store_name="mem"\} 1', text)
    assert not re.search(r'agent_memory_recall_hits_total\{store_name="mem"\} [1-9]', text)


async def test_counts_evictions_when_capacity_enforced() -> None:
    registry = CollectorRegistry()

    def handler(command: str, *args: Any) -> Any:
        if command == "FT.SEARCH":
            if "RETURN" in args:
                return ft_reply(
                    3,
                    [
                        ("mem:mem:a", eviction_fields(0.1, 1000)),
                        ("mem:mem:b", eviction_fields(0.9, 5000)),
                        ("mem:mem:c", eviction_fields(0.5, 9000)),
                    ],
                )
            return ft_reply(3)
        if command == "DEL":
            return len(args)
        return "OK"

    store = MemoryStore(
        client=fake_client(handler),
        name="mem",
        embed_fn=fake_embed(8),
        max_items_per_scope=2,
        telemetry=MemoryTelemetryOptions(registry=registry),
    )

    await store.remember("content", namespace="u1")

    text = metrics_text(registry)
    assert re.search(r'agent_memory_evictions_total\{store_name="mem"\} 1', text)


async def test_counts_consolidations() -> None:
    registry = CollectorRegistry()

    def handler(command: str, *args: Any) -> Any:
        if command == "FT.SEARCH":
            return ft_reply(1, [consolidate_hit("a")])
        if command == "DEL":
            return len(args)
        return "OK"

    store = MemoryStore(
        client=fake_client(handler),
        name="mem",
        embed_fn=fake_embed(8),
        telemetry=MemoryTelemetryOptions(registry=registry),
    )

    await store.consolidate(mode="summary", namespace="u1", summarize=make_summary)

    text = metrics_text(registry)
    assert re.search(r'agent_memory_consolidations_total\{store_name="mem"\} 1', text)


async def test_honours_configurable_metrics_prefix() -> None:
    registry = CollectorRegistry()
    store = MemoryStore(
        client=fake_client(),
        name="mem",
        embed_fn=fake_embed(8),
        telemetry=MemoryTelemetryOptions(registry=registry, metrics_prefix="mymem"),
    )

    await store.remember("hi")

    text = metrics_text(registry)
    assert re.search(r'mymem_embedding_calls_total\{store_name="mem"\} 1', text)
