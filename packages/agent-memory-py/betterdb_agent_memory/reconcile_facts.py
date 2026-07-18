"""Subject-keyed reconciliation of extracted facts (newer-wins, tombstones)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Union

from .types import Fact, MemoryItem


def fact_content(fact: Fact) -> str:
    """Render a fact's content for storage, preserving its asserted date as a prefix."""
    if fact.date is not None and fact.date != "":
        return f"[{fact.date}] {fact.statement}"
    return fact.statement


def stored_fact_to_fact(item: MemoryItem) -> Fact:
    """Recover a Fact from a stored fact memory.

    Datedness is read from the persisted ``date`` field (the source of truth), NOT
    inferred from a leading bracket in the content -- otherwise a dateless statement
    like ``"[Q3] revenue target is 5M"`` would round-trip into a spurious dated fact
    and corrupt newest-wins resolution. When a date is present the content was
    written as ``[date] statement``, so the known prefix is stripped to recover the
    statement (inverse of ``fact_content``).
    """
    subject = item.subject or ""
    date = item.date
    if date is None or date == "":
        return Fact(subject=subject, statement=item.content)
    prefix = f"[{date}] "
    statement = item.content[len(prefix) :] if item.content.startswith(prefix) else item.content
    return Fact(subject=subject, statement=statement, date=date)


@dataclass
class AddOp:
    fact: Fact
    type: Literal["add"] = "add"


@dataclass
class UpdateOp:
    subject: str
    fact: Fact
    type: Literal["update"] = "update"


@dataclass
class DeleteOp:
    subject: str
    type: Literal["delete"] = "delete"


@dataclass
class NoopOp:
    subject: str
    type: Literal["noop"] = "noop"


@dataclass
class UnmatchedTombstoneOp:
    # A tombstone whose subject matched no prior fact. It stores nothing (like a
    # noop) but is surfaced separately so the caller can log it instead of losing
    # it silently -- a model that mislabels a live fact as a tombstone shows here.
    subject: str
    type: Literal["unmatched-tombstone"] = "unmatched-tombstone"


# A single reconciliation decision for one incoming fact against the curated
# set: add a new subject, update it to a newer statement, delete it (tombstone),
# leave it unchanged, or surface an unmatched tombstone.
FactOp = Union[AddOp, UpdateOp, DeleteOp, NoopOp, UnmatchedTombstoneOp]


def subject_key(subject: str) -> str:
    """Match key for a subject: case- and whitespace-insensitive, so "Dashboard theme"
    and "dashboard theme" reconcile to the same fact. Only the match key is folded;
    the stored fact keeps its original subject casing.
    """
    return subject.strip().lower()


def _fact_date(fact: Fact) -> str | None:
    # Datedness is "has a non-empty date". An empty string is treated as dateless,
    # consistent with fact_content/stored_fact_to_fact/build_memory_record -- so a
    # fact with date="" behaves identically to one with no date at all.
    return None if fact.date is None or fact.date == "" else fact.date


def _is_newer(candidate: Fact, prior: Fact) -> bool:
    # A dateless candidate is the latest assertion we have, so it wins ties (and
    # any dated prior). A dated candidate wins when its date is at least the
    # prior's (a dateless prior counts as the epoch, so any dated candidate beats
    # it, and equal dates let the later batch assertion win).
    candidate_date = _fact_date(candidate)
    if candidate_date is None:
        return True
    return candidate_date >= (_fact_date(prior) or "")


def _is_stale_tombstone(tombstone: Fact, prior: Fact) -> bool:
    # A tombstone is stale only when both dates are known and it predates the
    # curated fact; a dateless tombstone still deletes (it carries no temporal
    # claim to lose against).
    tombstone_date = _fact_date(tombstone)
    prior_date = _fact_date(prior)
    return tombstone_date is not None and prior_date is not None and tombstone_date < prior_date


def reconcile(incoming: list[Fact], existing: list[Fact]) -> list[FactOp]:
    """Reconcile a batch of ``incoming`` facts against the ``existing`` curated set.

    Returns the ordered ops that transform one into the other. Facts are keyed by
    ``subject``: a newer statement updates, an equal one is a noop, a tombstone
    deletes (unless stale). Ops fold into the working set as they are produced so
    later facts in the same batch see earlier decisions.
    """
    by_subject: dict[str, Fact] = {}
    for fact in existing:
        by_subject[subject_key(fact.subject)] = fact

    ops: list[FactOp] = []
    for fact in incoming:
        key = subject_key(fact.subject)
        prior = by_subject.get(key)
        if fact.tombstone:
            if prior is None:
                # No live fact to retract: surface it rather than silently swallow it.
                ops.append(UnmatchedTombstoneOp(subject=fact.subject))
            elif _is_stale_tombstone(fact, prior):
                ops.append(NoopOp(subject=fact.subject))
            else:
                ops.append(DeleteOp(subject=fact.subject))
                del by_subject[key]
            continue
        if prior is None:
            ops.append(AddOp(fact=fact))
            by_subject[key] = fact
            continue
        if prior.statement == fact.statement:
            # Same claim restated: refresh only when this assertion carries a
            # strictly newer date, so newest-date-wins still governs the stored
            # [date] prefix. Equal/older/dateless restatements stay a noop (no
            # content change to rewrite).
            if (_fact_date(fact) or "") > (_fact_date(prior) or ""):
                ops.append(UpdateOp(subject=fact.subject, fact=fact))
                by_subject[key] = fact
            else:
                ops.append(NoopOp(subject=fact.subject))
            continue
        if _is_newer(fact, prior):
            ops.append(UpdateOp(subject=fact.subject, fact=fact))
            by_subject[key] = fact
            continue
        ops.append(NoopOp(subject=fact.subject))
    return ops


def apply_ops(existing: list[Fact], ops: list[FactOp]) -> list[Fact]:
    """Apply reconciliation ops to the ``existing`` set, returning the curated facts."""
    by_subject: dict[str, Fact] = {}
    for fact in existing:
        by_subject[subject_key(fact.subject)] = fact
    for op in ops:
        if isinstance(op, AddOp):
            by_subject[subject_key(op.fact.subject)] = op.fact
        elif isinstance(op, UpdateOp):
            by_subject[subject_key(op.subject)] = op.fact
        elif isinstance(op, DeleteOp):
            by_subject.pop(subject_key(op.subject), None)
        # NoopOp and UnmatchedTombstoneOp change nothing in the curated set.
    return list(by_subject.values())
