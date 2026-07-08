from __future__ import annotations

from betterdb_agent_memory import (
    AddOp,
    Fact,
    UpdateOp,
    apply_ops,
    reconcile,
)
from betterdb_agent_memory.reconcile_facts import fact_content, stored_fact_to_fact
from betterdb_agent_memory.types import MemoryItem


def _stored(subject: str, content: str, date: str | None = None) -> MemoryItem:
    return MemoryItem(
        id="x",
        content=content,
        importance=0.5,
        tags=[],
        created_at=0,
        last_accessed_at=0,
        access_count=0,
        subject=subject,
        date=date,
    )


def test_stored_fact_reads_datedness_from_the_date_field_not_a_leading_bracket() -> None:
    # Dateless statement that happens to start with a bracket -> stays dateless.
    assert stored_fact_to_fact(_stored("goal", "[Q3] revenue target is 5M")) == Fact(
        subject="goal", statement="[Q3] revenue target is 5M"
    )
    # Dated fact: date from the field, statement recovered by stripping the prefix.
    assert stored_fact_to_fact(_stored("employer", "[2024-06] Globex", "2024-06")) == Fact(
        subject="employer", statement="Globex", date="2024-06"
    )


def test_stored_fact_round_trips_a_dateless_bracketed_statement() -> None:
    fact = Fact(subject="goal", statement="[Q3] revenue target is 5M")
    content = fact_content(fact)
    assert content == "[Q3] revenue target is 5M"
    assert stored_fact_to_fact(_stored("goal", content)) == fact


def test_adds_a_fact_for_a_subject_not_yet_seen() -> None:
    ops = reconcile([Fact(subject="employer", statement="Acme")], [])
    assert ops == [AddOp(fact=Fact(subject="employer", statement="Acme"))]


def test_noops_when_incoming_restates_the_existing_statement() -> None:
    existing = [Fact(subject="employer", statement="Acme")]
    ops = reconcile([Fact(subject="employer", statement="Acme")], existing)
    assert [op.type for op in ops] == ["noop"]


def test_refreshes_the_date_when_same_statement_restated_with_a_newer_date() -> None:
    existing = [Fact(subject="employer", statement="Acme", date="2024-01-01")]
    ops = reconcile([Fact(subject="employer", statement="Acme", date="2024-06-01")], existing)
    assert ops == [
        UpdateOp(
            subject="employer",
            fact=Fact(subject="employer", statement="Acme", date="2024-06-01"),
        )
    ]


def test_noops_when_same_statement_restated_with_equal_or_older_date() -> None:
    existing = [Fact(subject="employer", statement="Acme", date="2024-06-01")]
    same = reconcile([Fact(subject="employer", statement="Acme", date="2024-06-01")], existing)
    assert [op.type for op in same] == ["noop"]
    older = reconcile([Fact(subject="employer", statement="Acme", date="2024-01-01")], existing)
    assert [op.type for op in older] == ["noop"]


def test_updates_to_a_newer_dated_statement_and_ignores_an_older_one() -> None:
    existing = [Fact(subject="employer", statement="Acme", date="2024-01-01")]
    newer = reconcile([Fact(subject="employer", statement="Globex", date="2024-06-01")], existing)
    assert newer == [
        UpdateOp(
            subject="employer",
            fact=Fact(subject="employer", statement="Globex", date="2024-06-01"),
        )
    ]
    older = reconcile([Fact(subject="employer", statement="Initech", date="2023-01-01")], existing)
    assert [op.type for op in older] == ["noop"]


def test_dateless_new_statement_wins_over_an_older_dated_fact() -> None:
    existing = [Fact(subject="employer", statement="Acme", date="2024-01-01")]
    ops = reconcile([Fact(subject="employer", statement="Globex")], existing)
    assert ops == [UpdateOp(subject="employer", fact=Fact(subject="employer", statement="Globex"))]


def test_empty_string_date_is_treated_as_dateless_and_supersedes_a_dated_prior() -> None:
    # date="" is dateless per fact_content/stored_fact_to_fact, so it must win over
    # a dated prior exactly like a None date -- not sort before it.
    existing = [Fact(subject="employer", statement="Acme", date="2024-01-01")]
    ops = reconcile([Fact(subject="employer", statement="Globex", date="")], existing)
    assert ops == [
        UpdateOp(subject="employer", fact=Fact(subject="employer", statement="Globex", date=""))
    ]


def test_empty_string_date_tombstone_still_retracts() -> None:
    existing = [Fact(subject="employer", statement="Acme", date="2024-06-01")]
    ops = reconcile([Fact(subject="employer", statement="", tombstone=True, date="")], existing)
    assert [op.type for op in ops] == ["delete"]


def test_deletes_on_a_tombstone_but_noops_on_a_stale_older_dated_tombstone() -> None:
    existing = [Fact(subject="employer", statement="Acme", date="2024-06-01")]
    live = reconcile(
        [Fact(subject="employer", statement="", tombstone=True, date="2024-07-01")], existing
    )
    assert live[0].type == "delete"
    stale = reconcile(
        [Fact(subject="employer", statement="", tombstone=True, date="2024-01-01")], existing
    )
    assert [op.type for op in stale] == ["noop"]


def test_folds_earlier_ops_so_a_later_fact_in_the_same_batch_sees_them() -> None:
    ops = reconcile(
        [
            Fact(subject="city", statement="Sofia", date="2024-01-01"),
            Fact(subject="city", statement="Berlin", date="2024-05-01"),
        ],
        [],
    )
    assert ops == [
        AddOp(fact=Fact(subject="city", statement="Sofia", date="2024-01-01")),
        UpdateOp(subject="city", fact=Fact(subject="city", statement="Berlin", date="2024-05-01")),
    ]


def test_apply_ops_produces_the_curated_set_after_add_update_delete() -> None:
    ops = reconcile(
        [
            Fact(subject="employer", statement="Acme"),
            Fact(subject="city", statement="Sofia"),
            Fact(subject="city", statement="Berlin", date="2024-05-01"),
        ],
        [],
    )
    curated = apply_ops([], ops)
    assert curated == [
        Fact(subject="employer", statement="Acme"),
        Fact(subject="city", statement="Berlin", date="2024-05-01"),
    ]


def test_apply_ops_drops_a_tombstoned_subject() -> None:
    existing = [Fact(subject="pet", statement="has a dog", date="2024-01-01")]
    ops = reconcile(
        [Fact(subject="pet", statement="", tombstone=True, date="2024-06-01")], existing
    )
    assert apply_ops(existing, ops) == []
