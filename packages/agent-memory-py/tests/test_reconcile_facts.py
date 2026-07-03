from __future__ import annotations

from betterdb_agent_memory import (
    AddOp,
    Fact,
    UpdateOp,
    apply_ops,
    reconcile,
)


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
