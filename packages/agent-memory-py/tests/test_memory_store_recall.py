from __future__ import annotations

from typing import Any

from betterdb_agent_memory import MemoryStore

from .conftest import fake_client, fake_embed, now_ms, search_reply

NOW = now_ms()


def spy_embed(dims: int) -> Any:
    base = fake_embed(dims)
    calls: list[str] = []

    async def embed(text: str) -> list[float]:
        calls.append(text)
        return await base(text)

    embed.calls = calls  # type: ignore[attr-defined]
    return embed


def base_fields(over: dict[str, str]) -> dict[str, str]:
    fields = {
        "content": "c",
        "importance": "0.5",
        "tags": "",
        "created_at": str(NOW),
        "last_accessed_at": str(NOW),
        "access_count": "0",
    }
    fields.update(over)
    return fields


async def test_embeds_query_runs_widened_knn_and_returns_ranked_hits_capped_at_k() -> None:
    embed_fn = spy_embed(8)
    reply = search_reply(
        [
            ("mem:mem:a", base_fields({"content": "closer", "__score": "0.1"})),
            ("mem:mem:b", base_fields({"content": "farther", "__score": "0.6"})),
        ]
    )
    client = fake_client(lambda command, *args: reply if command == "FT.SEARCH" else "OK")
    store = MemoryStore(client=client, name="mem", embed_fn=embed_fn)

    hits = await store.recall(
        "what does the user prefer", k=2, threshold=1, thread_id="t1", tags=["x"]
    )

    assert embed_fn.calls == ["what does the user prefer"]
    search = client.find_call("FT.SEARCH")
    assert search is not None
    assert search[1] == "mem:mem:idx"
    # internal k widened to k*4 = 8
    assert search[2] == "(@threadId:{t1} @tags:{x})=>[KNN 8 @vector $vec AS __score]"
    assert "8" in search

    assert len(hits) == 2
    assert hits[0].item.id == "a"
    assert hits[0].item.content == "closer"
    assert hits[0].similarity == 0.1
    assert hits[0].score > hits[1].score


async def test_drops_candidates_beyond_distance_threshold() -> None:
    reply = search_reply(
        [
            ("mem:mem:a", base_fields({"__score": "0.1"})),
            ("mem:mem:b", base_fields({"__score": "0.9"})),
        ]
    )
    client = fake_client(lambda command, *args: reply if command == "FT.SEARCH" else "OK")
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    hits = await store.recall("q", k=5, threshold=0.3)

    assert [h.item.id for h in hits] == ["a"]


async def test_returns_a_candidate_at_distance_0_27_with_the_default_threshold() -> None:
    reply = search_reply([("mem:mem:a", base_fields({"__score": "0.27"}))])
    client = fake_client(lambda command, *args: reply if command == "FT.SEARCH" else "OK")
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    # No explicit threshold: the default (0.33) must admit a ~0.27 match, which the
    # old 0.25 default silently dropped for mainstream embedding models.
    hits = await store.recall("q", k=5)

    assert [h.item.id for h in hits] == ["a"]


async def test_flags_a_near_miss_and_warns_once_per_store(recwarn: Any) -> None:
    reply = search_reply([("mem:mem:a", base_fields({"__score": "0.4"}))])
    client = fake_client(lambda command, *args: reply if command == "FT.SEARCH" else "OK")
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    first = await store.recall("q", k=5)  # 0.4 > 0.33 default, but <= 2x
    second = await store.recall("q", k=5)

    assert first == []
    assert second == []
    near_miss = [w for w in recwarn.list if "nearest candidate" in str(w.message)]
    assert len(near_miss) == 1  # deduped per store


async def test_does_not_flag_a_near_miss_when_nearest_is_far_past_threshold(recwarn: Any) -> None:
    reply = search_reply([("mem:mem:a", base_fields({"__score": "0.9"}))])
    client = fake_client(lambda command, *args: reply if command == "FT.SEARCH" else "OK")
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    hits = await store.recall("q", k=5)  # 0.9 > 2x * 0.33

    assert hits == []
    assert not any("nearest candidate" in str(w.message) for w in recwarn.list)


async def test_drops_candidates_with_missing_or_non_numeric_distance() -> None:
    reply = search_reply(
        [
            ("mem:mem:a", base_fields({"__score": "0.1"})),
            ("mem:mem:b", base_fields({})),
        ]
    )
    client = fake_client(lambda command, *args: reply if command == "FT.SEARCH" else "OK")
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    hits = await store.recall("q", k=5, threshold=1)

    assert [h.item.id for h in hits] == ["a"]


async def test_drops_candidate_with_empty_distance_not_treated_as_zero() -> None:
    reply = search_reply(
        [
            ("mem:mem:a", base_fields({"__score": "0.1"})),
            ("mem:mem:b", base_fields({"__score": "   "})),
        ]
    )
    client = fake_client(lambda command, *args: reply if command == "FT.SEARCH" else "OK")
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    hits = await store.recall("q", k=5, threshold=1)

    assert [h.item.id for h in hits] == ["a"]


async def test_drops_candidate_with_nan_composite_score() -> None:
    reply = search_reply(
        [
            ("mem:mem:a", base_fields({"__score": "0.1"})),
            ("mem:mem:b", base_fields({"__score": "0.1", "importance": "not-a-number"})),
        ]
    )
    client = fake_client(lambda command, *args: reply if command == "FT.SEARCH" else "OK")
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    hits = await store.recall("q", k=5, threshold=1)

    assert [h.item.id for h in hits] == ["a"]


async def test_ranks_reinforced_recent_memory_above_equally_similar_stale_one() -> None:
    old = str(NOW - 30 * 24 * 3600 * 1000)
    reply = search_reply(
        [
            (
                "mem:mem:stale",
                base_fields({"__score": "0.1", "created_at": old, "last_accessed_at": old}),
            ),
            (
                "mem:mem:fresh",
                base_fields({"__score": "0.1", "created_at": old, "last_accessed_at": str(NOW)}),
            ),
        ]
    )
    client = fake_client(lambda command, *args: reply if command == "FT.SEARCH" else "OK")
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    hits = await store.recall("q", reinforce=False)

    assert [h.item.id for h in hits] == ["fresh", "stale"]
    assert hits[0].score > hits[1].score
