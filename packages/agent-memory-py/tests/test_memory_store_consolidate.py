from __future__ import annotations

from typing import Any

import pytest
from betterdb_agent_memory import MemoryStore

from .conftest import fake_client, fake_embed, ft_reply, now_ms

NOW = now_ms()


def item_hit(
    id: str, importance: float, age_seconds: int, source: str | None = None
) -> tuple[str, dict[str, str]]:
    created = NOW - age_seconds * 1000
    fields = {
        "content": f"c-{id}",
        "importance": str(importance),
        "created_at": str(created),
        "last_accessed_at": str(created),
        "access_count": "0",
    }
    if source is not None:
        fields["source"] = source
    return (f"mem:mem:{id}", fields)


def consolidating_client(hits: list[tuple[str, dict[str, str]]]) -> Any:
    reply = ft_reply(len(hits), hits)

    def handler(command: str, *args: Any) -> Any:
        if command == "FT.SEARCH":
            return reply
        if command == "DEL":
            return len(args)
        return "OK"

    return fake_client(handler)


def field_value(call: list[Any] | None, field: str) -> Any:
    if call is None or field not in call:
        return None
    return call[call.index(field) + 1]


def make_summarize() -> Any:
    calls: list[list[Any]] = []

    async def summarize(items: list[Any]) -> str:
        calls.append(items)
        return f"summary of {len(items)}"

    summarize.calls = calls  # type: ignore[attr-defined]
    return summarize


async def test_summarizes_writes_summary_deletes_sources_returns_counts() -> None:
    summarize = make_summarize()
    client = consolidating_client([item_hit("a", 0.2, 100000), item_hit("b", 0.3, 200000)])
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    result = await store.consolidate(mode="summary",
        namespace="u1", older_than_seconds=3600, max_importance=0.5, summarize=summarize
    )

    assert len(summarize.calls) == 1
    # Ordered oldest->newest: 'b' (age 200000s) precedes 'a' (age 100000s).
    assert [i.id for i in summarize.calls[0]] == ["b", "a"]
    assert result.consolidated == 2
    assert len(result.created) == 1
    assert result.deleted == 2

    hset = client.find_call("HSET")
    assert field_value(hset, "content") == "summary of 2"
    assert field_value(hset, "source") == "summary"
    assert hset[1] == f"mem:mem:{result.created[0]}"

    del_call = client.find_call("DEL")
    assert sorted(del_call[1:]) == ["mem:mem:a", "mem:mem:b"]


async def test_pushes_older_than_seconds_as_created_at_upper_bound() -> None:
    summarize = make_summarize()
    client = consolidating_client([item_hit("a", 0.2, 100000)])
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    await store.consolidate(mode="summary",older_than_seconds=3600, summarize=summarize)

    search = client.find_call("FT.SEARCH")
    assert search is not None
    import re

    assert re.search(r"@created_at:\[-inf \d+\]", search[2])


async def test_pushes_max_importance_as_importance_upper_bound() -> None:
    summarize = make_summarize()
    client = consolidating_client([item_hit("a", 0.2, 100000)])
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    await store.consolidate(mode="summary",max_importance=0.5, summarize=summarize)

    search = client.find_call("FT.SEARCH")
    assert "@importance:[-inf 0.5]" in search[2]


async def test_excludes_prior_summaries_from_candidate_scan() -> None:
    summarize = make_summarize()
    client = consolidating_client([item_hit("a", 0.2, 100000)])
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    await store.consolidate(mode="summary",namespace="u1", summarize=summarize)

    search = client.find_call("FT.SEARCH")
    assert "-@source:{summary}" in search[2]


async def test_writes_summary_scoped_to_request_at_summary_importance() -> None:
    summarize = make_summarize()
    client = consolidating_client([item_hit("a", 0.1, 100000)])
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    await store.consolidate(mode="summary",namespace="u1", summarize=summarize, summary_importance=0.9)

    hset = client.find_call("HSET")
    assert field_value(hset, "importance") == "0.9"
    assert field_value(hset, "namespace") == "u1"
    assert field_value(hset, "source") == "summary"


async def test_keeps_sources_when_delete_sources_false() -> None:
    summarize = make_summarize()
    client = consolidating_client([item_hit("a", 0.2, 100000), item_hit("b", 0.2, 100000)])
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    result = await store.consolidate(mode="summary",
        summarize=summarize, delete_sources=False, older_than_seconds=3600
    )

    assert result.consolidated == 2
    assert len(result.created) == 1
    assert result.deleted == 0
    assert not any(c[0] == "DEL" for c in client.calls)


async def test_returns_zeros_and_does_not_summarize_when_nothing_matches() -> None:
    summarize = make_summarize()
    client = consolidating_client([])
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    result = await store.consolidate(mode="summary",older_than_seconds=3600, summarize=summarize)

    assert len(summarize.calls) == 0
    assert result.consolidated == 0
    assert result.created == []
    assert result.deleted == 0
    assert not any(c[0] == "HSET" for c in client.calls)
    assert not any(c[0] == "DEL" for c in client.calls)


async def test_throws_without_scope_tags_or_criteria() -> None:
    summarize = make_summarize()
    store = MemoryStore(client=fake_client(), name="mem", embed_fn=fake_embed(8))

    with pytest.raises(ValueError, match="scope|criteria"):
        await store.consolidate(mode="summary", summarize=summarize)
    assert len(summarize.calls) == 0


async def test_raises_on_an_unknown_consolidate_mode() -> None:
    summarize = make_summarize()
    store = MemoryStore(client=fake_client(), name="mem", embed_fn=fake_embed(8))

    with pytest.raises(ValueError, match="unknown mode"):
        await store.consolidate(mode="fact", namespace="u1", summarize=summarize)  # type: ignore[arg-type]


async def test_defaults_summary_importance_to_point_seven_and_deletes_by_default() -> None:
    summarize = make_summarize()
    client = consolidating_client([item_hit("a", 0.2, 100000)])
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    result = await store.consolidate(mode="summary",summarize=summarize, older_than_seconds=3600)

    hset = client.find_call("HSET")
    assert field_value(hset, "importance") == "0.7"
    assert result.deleted == 1


async def test_writes_summary_without_capacity_pass() -> None:
    summarize = make_summarize()
    client = consolidating_client([item_hit("a", 0.2, 100000), item_hit("b", 0.2, 100000)])
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), max_items_per_scope=1)

    result = await store.consolidate(mode="summary",namespace="u1", summarize=summarize)

    assert len(result.created) == 1
    assert any(c[0] == "HSET" for c in client.calls)
    # Exactly one FT.SEARCH (the candidate scan): the summary write triggers no
    # capacity probe, so enforce_capacity can't evict the just-written summary.
    assert len(client.calls_for("FT.SEARCH")) == 1
