from __future__ import annotations

from typing import Any

from betterdb_agent_memory import MemoryStore

from .conftest import fake_client, fake_embed, ft_reply, now_ms


def span_named(exporter: Any, name: str) -> Any:
    return next((s for s in exporter.get_finished_spans() if s.name == name), None)


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


async def test_emits_remember_span_with_importance_attribute(span_exporter: Any) -> None:
    store = MemoryStore(client=fake_client(), name="mem", embed_fn=fake_embed(8))

    await store.remember("hi", importance=0.8)

    span = span_named(span_exporter, "agent_memory.remember")
    assert span is not None
    assert span.attributes["memory.importance"] == 0.8


async def test_emits_recall_span_with_k_and_result_count(span_exporter: Any) -> None:
    client = fake_client(lambda command, *args: recall_hit(0.1) if command == "FT.SEARCH" else "OK")
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    await store.recall("q", k=1)

    span = span_named(span_exporter, "agent_memory.recall")
    assert span is not None
    assert span.attributes["recall.k"] == 1
    assert span.attributes["recall.result_count"] == 1


async def test_emits_consolidate_span_with_counts(span_exporter: Any) -> None:
    def handler(command: str, *args: Any) -> Any:
        if command == "FT.SEARCH":
            return ft_reply(1, [consolidate_hit("a")])
        if command == "DEL":
            return len(args)
        return "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    await store.consolidate(mode="summary", namespace="u1", summarize=make_summary)

    span = span_named(span_exporter, "agent_memory.consolidate")
    assert span is not None
    assert span.attributes["consolidate.candidates"] == 1
    assert span.attributes["consolidate.created"] == 1
    assert span.attributes["consolidate.deleted"] == 1
