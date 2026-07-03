"""Subject-keyed reconciliation of extracted facts (newer-wins, tombstones)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, Union

from .types import Fact, MemoryItem

# A stored fact memory's content is ``[date] statement`` when the fact carried a
# date, else the bare statement. This matches that prefix so a stored fact can be
# recovered for reconciliation.
_DATED_CONTENT = re.compile(r"^\[([^\]]+)\] (.*)$", re.DOTALL)


def fact_content(fact: Fact) -> str:
    """Render a fact's content for storage, preserving its asserted date as a prefix."""
    if fact.date is not None and fact.date != "":
        return f"[{fact.date}] {fact.statement}"
    return fact.statement


def stored_fact_to_fact(item: MemoryItem) -> Fact:
    """Recover a Fact from a stored fact memory.

    The reconcile key comes from the persisted ``subject``, the statement and date
    from the ``[date] statement`` content (inverse of ``fact_content``).
    """
    match = _DATED_CONTENT.match(item.content)
    subject = item.subject or ""
    if match:
        return Fact(subject=subject, statement=match.group(2), date=match.group(1))
    return Fact(subject=subject, statement=item.content)


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


# A single reconciliation decision for one incoming fact against the curated
# set: add a new subject, update it to a newer statement, delete it (tombstone),
# or leave it unchanged.
FactOp = Union[AddOp, UpdateOp, DeleteOp, NoopOp]


def _is_newer(candidate: Fact, prior: Fact) -> bool:
    # A dateless candidate is the latest assertion we have, so it wins ties (and
    # any dated prior). A dated candidate wins when its date is at least the
    # prior's (a dateless prior counts as the epoch, so any dated candidate beats
    # it, and equal dates let the later batch assertion win).
    if candidate.date is None:
        return True
    return candidate.date >= (prior.date or "")


def _is_stale_tombstone(tombstone: Fact, prior: Fact) -> bool:
    # A tombstone is stale only when both dates are known and it predates the
    # curated fact; a dateless tombstone still deletes (it carries no temporal
    # claim to lose against).
    return tombstone.date is not None and prior.date is not None and tombstone.date < prior.date


def reconcile(incoming: list[Fact], existing: list[Fact]) -> list[FactOp]:
    """Reconcile a batch of ``incoming`` facts against the ``existing`` curated set.

    Returns the ordered ops that transform one into the other. Facts are keyed by
    ``subject``: a newer statement updates, an equal one is a noop, a tombstone
    deletes (unless stale). Ops fold into the working set as they are produced so
    later facts in the same batch see earlier decisions.
    """
    by_subject: dict[str, Fact] = {}
    for fact in existing:
        by_subject[fact.subject] = fact

    ops: list[FactOp] = []
    for fact in incoming:
        prior = by_subject.get(fact.subject)
        if fact.tombstone:
            if prior is None or _is_stale_tombstone(fact, prior):
                ops.append(NoopOp(subject=fact.subject))
            else:
                ops.append(DeleteOp(subject=fact.subject))
                del by_subject[fact.subject]
            continue
        if prior is None:
            ops.append(AddOp(fact=fact))
            by_subject[fact.subject] = fact
            continue
        if prior.statement == fact.statement:
            # Same claim restated: refresh only when this assertion carries a
            # strictly newer date, so newest-date-wins still governs the stored
            # [date] prefix. Equal/older/dateless restatements stay a noop (no
            # content change to rewrite).
            if (fact.date or "") > (prior.date or ""):
                ops.append(UpdateOp(subject=fact.subject, fact=fact))
                by_subject[fact.subject] = fact
            else:
                ops.append(NoopOp(subject=fact.subject))
            continue
        if _is_newer(fact, prior):
            ops.append(UpdateOp(subject=fact.subject, fact=fact))
            by_subject[fact.subject] = fact
            continue
        ops.append(NoopOp(subject=fact.subject))
    return ops


def apply_ops(existing: list[Fact], ops: list[FactOp]) -> list[Fact]:
    """Apply reconciliation ops to the ``existing`` set, returning the curated facts."""
    by_subject: dict[str, Fact] = {}
    for fact in existing:
        by_subject[fact.subject] = fact
    for op in ops:
        if isinstance(op, AddOp):
            by_subject[op.fact.subject] = op.fact
        elif isinstance(op, UpdateOp):
            by_subject[op.subject] = op.fact
        elif isinstance(op, DeleteOp):
            by_subject.pop(op.subject, None)
    return list(by_subject.values())
