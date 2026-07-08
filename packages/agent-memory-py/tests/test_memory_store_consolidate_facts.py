from __future__ import annotations

import re
from typing import Any

import pytest
from betterdb_agent_memory import ConsolidationConfig, Fact, MemoryStore

from .conftest import fake_client, fake_embed, ft_reply, now_ms

NOW = now_ms()


def item_hit(id: str, importance: float, age_seconds: int) -> tuple[str, dict[str, str]]:
    created = NOW - age_seconds * 1000
    return (
        f"mem:mem:{id}",
        {
            "content": f"c-{id}",
            "importance": str(importance),
            "created_at": str(created),
            "last_accessed_at": str(created),
            "access_count": "0",
        },
    )


def facts_client(hits: list[tuple[str, dict[str, str]]]) -> Any:
    reply = ft_reply(len(hits), hits)

    def handler(command: str, *args: Any) -> Any:
        if command == "FT.SEARCH":
            return reply
        return "OK"

    return fake_client(handler)


def fact_hit(
    id: str, subject: str, content: str, date: str | None = None
) -> tuple[str, dict[str, str]]:
    # A stored fact memory: carries source=fact and a persisted subject so a later
    # run can reconcile against it. Datedness is carried in its own ``date`` field
    # (the source of truth), matching how consolidate_facts writes dated facts.
    fields = {"content": content, "subject": subject, "source": "fact"}
    if date is not None:
        fields["date"] = date
    return (f"mem:mem:{id}", fields)


def two_phase_client(
    candidate_hits: list[tuple[str, dict[str, str]]],
    existing_fact_hits: list[tuple[str, dict[str, str]]],
) -> Any:
    # The candidate scan excludes facts (``-@source``), the existing-fact scan
    # includes them (``@source:{fact}``); route each to its own reply.
    def handler(command: str, *args: Any) -> Any:
        if command == "FT.SEARCH":
            filter_q = str(args[1])
            hits = candidate_hits if "-@source" in filter_q else existing_fact_hits
            return ft_reply(len(hits), hits)
        if command == "DEL":
            return len(args)
        return "OK"

    return fake_client(handler)


def field_value(call: list[Any] | None, field: str) -> Any:
    if call is None or field not in call:
        return None
    return call[call.index(field) + 1]


def extractor(facts: list[Fact]) -> Any:
    calls: list[list[Any]] = []

    async def extract(items: list[Any]) -> list[Fact]:
        calls.append(items)
        return facts

    extract.calls = calls  # type: ignore[attr-defined]
    return extract


async def test_raises_when_disabled_by_default_without_touching_client() -> None:
    client = facts_client([item_hit("a", 0.2, 100000)])
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))
    extract = extractor([Fact(subject="employer", statement="Acme")])

    with pytest.raises(RuntimeError, match="disabled"):
        await store.consolidate_facts(namespace="u1", extract_facts=extract)
    assert len(extract.calls) == 0
    assert not any(c[0] == "FT.SEARCH" for c in client.calls)


async def test_runs_when_enabled_via_consolidation_true() -> None:
    client = facts_client([item_hit("a", 0.2, 100000)])
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), consolidation=True)
    extract = extractor([Fact(subject="employer", statement="Acme")])

    result = await store.consolidate_facts(namespace="u1", extract_facts=extract)

    assert len(extract.calls) == 1
    assert result.candidates == 1
    assert result.facts == 1
    assert len(result.created) == 1


async def test_enabled_via_config_object_and_disabled_when_enabled_false() -> None:
    on = MemoryStore(
        client=facts_client([item_hit("a", 0.2, 100000)]),
        name="mem",
        embed_fn=fake_embed(8),
        consolidation=ConsolidationConfig(enabled=True),
    )
    result = await on.consolidate_facts(namespace="u1", extract_facts=extractor([]))
    assert result is not None

    off = MemoryStore(
        client=facts_client([]),
        name="mem",
        embed_fn=fake_embed(8),
        consolidation=ConsolidationConfig(enabled=False),
    )
    with pytest.raises(RuntimeError, match="disabled"):
        await off.consolidate_facts(namespace="u1", extract_facts=extractor([]))


async def test_writes_fact_memories_additively_without_deleting_sources() -> None:
    client = facts_client([item_hit("a", 0.2, 100000), item_hit("b", 0.3, 200000)])
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), consolidation=True)
    extract = extractor([Fact(subject="employer", statement="Acme")])

    result = await store.consolidate_facts(namespace="u1", extract_facts=extract)

    assert result.candidates == 2
    assert result.facts == 1
    assert not any(c[0] == "DEL" for c in client.calls)
    hset = client.find_call("HSET")
    assert field_value(hset, "content") == "Acme"
    assert field_value(hset, "source") == "fact"


async def test_preserves_a_fact_date_by_prefixing_it_into_content() -> None:
    client = facts_client([item_hit("a", 0.2, 100000)])
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), consolidation=True)
    extract = extractor([Fact(subject="employer", statement="Globex", date="2024-06-01")])

    await store.consolidate_facts(namespace="u1", extract_facts=extract)

    hset = client.find_call("HSET")
    assert field_value(hset, "content") == "[2024-06-01] Globex"


async def test_excludes_prior_fact_memories_from_candidate_scan() -> None:
    client = facts_client([item_hit("a", 0.2, 100000)])
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), consolidation=True)

    await store.consolidate_facts(namespace="u1", extract_facts=extractor([]))

    search = client.find_call("FT.SEARCH")
    assert "-@source:{fact}" in search[2]


async def test_uses_custom_fact_source_for_write_and_exclusion() -> None:
    client = facts_client([item_hit("a", 0.2, 100000)])
    store = MemoryStore(
        client=client,
        name="mem",
        embed_fn=fake_embed(8),
        consolidation=ConsolidationConfig(fact_source="distilled"),
    )
    extract = extractor([Fact(subject="employer", statement="Acme")])

    await store.consolidate_facts(namespace="u1", extract_facts=extract)

    search = client.find_call("FT.SEARCH")
    assert "-@source:{distilled}" in search[2]
    hset = client.find_call("HSET")
    assert field_value(hset, "source") == "distilled"


async def test_default_fact_importance_and_constructor_and_per_call_overrides() -> None:
    default_client = facts_client([item_hit("a", 0.2, 100000)])
    default_store = MemoryStore(
        client=default_client, name="mem", embed_fn=fake_embed(8), consolidation=True
    )
    await default_store.consolidate_facts(
        namespace="u1", extract_facts=extractor([Fact(subject="s", statement="x")])
    )
    assert field_value(default_client.find_call("HSET"), "importance") == "0.7"

    configured_client = facts_client([item_hit("a", 0.2, 100000)])
    configured = MemoryStore(
        client=configured_client,
        name="mem",
        embed_fn=fake_embed(8),
        consolidation=ConsolidationConfig(fact_importance=0.9),
    )
    await configured.consolidate_facts(
        namespace="u1", extract_facts=extractor([Fact(subject="s", statement="x")])
    )
    assert field_value(configured_client.find_call("HSET"), "importance") == "0.9"

    per_call_client = facts_client([item_hit("a", 0.2, 100000)])
    per_call = MemoryStore(
        client=per_call_client,
        name="mem",
        embed_fn=fake_embed(8),
        consolidation=ConsolidationConfig(fact_importance=0.9),
    )
    await per_call.consolidate_facts(
        namespace="u1",
        fact_importance=0.4,
        extract_facts=extractor([Fact(subject="s", statement="x")]),
    )
    assert field_value(per_call_client.find_call("HSET"), "importance") == "0.4"


async def test_reconciles_extracted_batch_newer_dated_wins() -> None:
    client = facts_client([item_hit("a", 0.2, 100000)])
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), consolidation=True)
    extract = extractor(
        [
            Fact(subject="city", statement="Sofia", date="2024-01-01"),
            Fact(subject="city", statement="Berlin", date="2024-05-01"),
        ]
    )

    result = await store.consolidate_facts(namespace="u1", extract_facts=extract)

    assert result.facts == 1
    hset = client.find_call("HSET")
    assert field_value(hset, "content") == "[2024-05-01] Berlin"


async def test_drops_a_tombstoned_subject_so_no_memory_is_written() -> None:
    client = facts_client([item_hit("a", 0.2, 100000)])
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), consolidation=True)
    extract = extractor([Fact(subject="pet", statement="", tombstone=True)])

    result = await store.consolidate_facts(namespace="u1", extract_facts=extract)

    assert result.facts == 0
    assert not any(c[0] == "HSET" for c in client.calls)


async def test_pushes_older_than_seconds_and_max_importance_into_scan() -> None:
    client = facts_client([item_hit("a", 0.2, 100000)])
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), consolidation=True)

    await store.consolidate_facts(
        older_than_seconds=3600, max_importance=0.5, extract_facts=extractor([])
    )

    search = client.find_call("FT.SEARCH")
    assert re.search(r"@created_at:\[-inf \d+\]", search[2])
    assert "@importance:[-inf 0.5]" in search[2]


async def test_returns_zeros_and_does_not_extract_when_nothing_matches() -> None:
    client = facts_client([])
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), consolidation=True)
    extract = extractor([Fact(subject="employer", statement="Acme")])

    result = await store.consolidate_facts(older_than_seconds=3600, extract_facts=extract)

    assert len(extract.calls) == 0
    assert result.candidates == 0
    assert result.facts == 0
    assert result.created == []
    assert not any(c[0] == "HSET" for c in client.calls)


async def test_raises_without_scope_tags_or_criteria() -> None:
    store = MemoryStore(
        client=facts_client([]), name="mem", embed_fn=fake_embed(8), consolidation=True
    )
    extract = extractor([Fact(subject="employer", statement="Acme")])

    with pytest.raises(ValueError, match="scope|criteria"):
        await store.consolidate_facts(extract_facts=extract)
    assert len(extract.calls) == 0


def include_source_search(client: Any) -> list[Any] | None:
    # The existing-fact scan is the FT.SEARCH whose filter includes a fact source
    # WITHOUT the leading '-' (which marks the candidate-exclusion scan).
    for call in client.calls_for("FT.SEARCH"):
        filter_q = str(call[2])
        if "@source:{fact}" in filter_q and "-@source:{fact}" not in filter_q:
            return call
    return None


async def test_loads_stored_fact_memories_with_an_include_filter() -> None:
    client = two_phase_client(
        [item_hit("a", 0.2, 100000)],
        [fact_hit("f1", "city", "[2024-01-01] Sofia")],
    )
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), consolidation=True)

    await store.consolidate_facts(namespace="u1", extract_facts=extractor([]))

    include = include_source_search(client)
    assert include is not None
    assert "RETURN" in include
    assert include[include.index("RETURN") + 2 : include.index("RETURN") + 5] == [
        "content",
        "subject",
        "source",
    ]


async def test_is_idempotent_rewriting_nothing_for_an_unchanged_fact() -> None:
    client = two_phase_client(
        [item_hit("a", 0.2, 100000)],
        [fact_hit("f1", "city", "Berlin")],
    )
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), consolidation=True)
    extract = extractor([Fact(subject="city", statement="Berlin")])

    result = await store.consolidate_facts(namespace="u1", extract_facts=extract)

    assert result.candidates == 1
    assert result.facts == 1
    assert result.created == []
    assert result.deleted == 0
    assert not any(c[0] == "HSET" for c in client.calls)
    assert not any(c[0] == "DEL" for c in client.calls)


async def test_supersedes_a_stored_fact_deleting_prior_and_writing_new() -> None:
    client = two_phase_client(
        [item_hit("a", 0.2, 100000)],
        [fact_hit("f1", "city", "[2024-01-01] Sofia", date="2024-01-01")],
    )
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), consolidation=True)
    extract = extractor([Fact(subject="city", statement="Berlin", date="2024-05-01")])

    result = await store.consolidate_facts(namespace="u1", extract_facts=extract)

    assert result.deleted == 1
    delete = client.find_call("DEL")
    assert delete is not None and "mem:mem:f1" in delete
    hset = client.find_call("HSET")
    assert field_value(hset, "content") == "[2024-05-01] Berlin"
    assert field_value(hset, "subject") == "city"


async def test_does_not_misread_a_dateless_stored_fact_starting_with_a_bracket() -> None:
    # "[Q3] revenue target is 5M" is a dateless statement, not a fact dated "Q3".
    # Inferring a date from the leading bracket would make the stored fact look
    # dated ("Q3"), and a genuinely newer dated restatement ("2024-09") would be
    # dropped by the string compare ('2' < 'Q'). Datedness must come from the
    # absent ``date`` field, so the newer dated fact supersedes it.
    client = two_phase_client(
        [item_hit("a", 0.2, 100000)],
        [fact_hit("f1", "goal", "[Q3] revenue target is 5M")],
    )
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), consolidation=True)
    extract = extractor(
        [Fact(subject="goal", statement="revenue target is 10M", date="2024-09")]
    )

    result = await store.consolidate_facts(namespace="u1", extract_facts=extract)

    assert result.deleted == 1
    assert len(result.created) == 1
    delete = client.find_call("DEL")
    assert delete is not None and "mem:mem:f1" in delete
    hset = client.find_call("HSET")
    assert field_value(hset, "content") == "[2024-09] revenue target is 10M"
    assert field_value(hset, "date") == "2024-09"


async def test_self_heals_a_concurrent_write_race_by_retracting_duplicate_subjects() -> None:
    # Two prior runs each wrote a fact for the same subject (a race). The next run
    # keeps one canonical row and retracts the extra so it is not orphaned.
    client = two_phase_client(
        [item_hit("a", 0.2, 100000)],
        [fact_hit("f1", "employer", "Acme"), fact_hit("f2", "employer", "Acme")],
    )
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), consolidation=True)
    extract = extractor([Fact(subject="employer", statement="Acme")])

    result = await store.consolidate_facts(namespace="u1", extract_facts=extract)

    assert len(result.created) == 0
    assert result.deleted == 1
    delete = client.find_call("DEL")
    assert delete is not None and "mem:mem:f2" in delete


async def test_retracts_a_stored_fact_across_runs_via_tombstone() -> None:
    client = two_phase_client(
        [item_hit("a", 0.2, 100000)],
        [fact_hit("f1", "city", "[2024-01-01] Sofia")],
    )
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), consolidation=True)
    extract = extractor([Fact(subject="city", statement="", tombstone=True)])

    result = await store.consolidate_facts(namespace="u1", extract_facts=extract)

    assert result.deleted == 1
    delete = client.find_call("DEL")
    assert delete is not None and "mem:mem:f1" in delete
    assert not any(c[0] == "HSET" for c in client.calls)
