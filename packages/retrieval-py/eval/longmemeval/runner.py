from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

from betterdb_retrieval import RetrievalSchema, Retriever

from .adapter import chunk_record, record_is_hit
from .types import ChunkMode, Embedder, Judge, LmeRecord, Reader, Store


@dataclass
class RunConfig:
    records: list[LmeRecord]
    embedder: Embedder
    store: Store
    reader: Optional[Reader]
    judge: Optional[Judge]
    k: int
    chunk_mode: ChunkMode
    limit: int


@dataclass
class TypeStats:
    type: str
    total: int = 0
    recall_hits: int = 0
    qa_correct: int = 0


@dataclass
class EvalSummary:
    total: int
    recall_hits: int
    recall_at_k: float
    qa_run: bool
    qa_correct: int
    qa_accuracy: float
    k: int
    total_chunks: int
    by_type: dict[str, TypeStats] = field(default_factory=dict)


async def _poll_until(predicate: Callable[[], Awaitable[bool]], attempts: int = 40) -> bool:
    for _ in range(attempts):
        if await predicate():
            return True
        await asyncio.sleep(0.1)
    return False


def _build_schema(dims: int) -> RetrievalSchema:
    return {
        "fields": {
            "session_id": {"type": "tag"},
            "date": {"type": "tag"},
        },
        "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": dims},
    }


def _bump(by_type: dict[str, TypeStats], type_name: str) -> TypeStats:
    stats = by_type.get(type_name)
    if stats is None:
        stats = TypeStats(type=type_name)
        by_type[type_name] = stats
    return stats


async def run_eval(config: RunConfig) -> EvalSummary:
    qa_run = config.reader is not None and config.judge is not None
    schema = _build_schema(config.embedder.dims)
    by_type: dict[str, TypeStats] = {}

    total = 0
    recall_hits = 0
    qa_correct = 0
    total_chunks = 0

    sliced = config.records[: config.limit]
    started_at = time.monotonic()
    # Flush in ``finally`` so a mid-run failure (embedding/Valkey/reader error)
    # still persists the embeddings already computed — billable work must not be
    # discarded just because the run didn't reach the end.
    try:
        for i, record in enumerate(sliced):
            name = f"lme_{i}_{secrets.token_hex(3)}"
            retriever = Retriever(
                client=config.store.client,
                name=name,
                schema=schema,
                embed_fn=config.embedder.embed,
            )

            chunks = chunk_record(record, config.chunk_mode)
            total_chunks += len(chunks)

            await retriever.create_index()
            await retriever.upsert(chunks)

            if config.store.is_real:
                # A hit-count check can pass while HNSW is still backfilling. Wait
                # for the index to report every chunk ingested and fully indexed so
                # recall is not measured on an incomplete graph.
                async def _settled() -> bool:
                    h = await retriever.health()
                    # percent_indexed is normalized to a 0-100 scale; require full
                    # coverage.
                    return h.num_docs >= len(chunks) and h.percent_indexed >= 100

                settled = await _poll_until(_settled)
                if not settled:
                    print(
                        f"index {name} did not settle within the poll window "
                        f"(record {i + 1}); recall may be undercounted"
                    )

            hits = await retriever.query(text=record["question"], k=config.k)
            hit = record_is_hit(hits, record["answer_session_ids"])

            stats = _bump(by_type, record["question_type"])
            stats.total += 1
            total += 1
            if hit:
                stats.recall_hits += 1
                recall_hits += 1

            if qa_run and config.reader is not None and config.judge is not None:
                # Temporal-reasoning questions need the session date (stored on the
                # chunk's ``date`` tag) and the question's asked-on date in the
                # prompt; passing only hit.text strips both and depresses temporal
                # QA. Prefix each excerpt with its date and carry question_date
                # into the question the reader sees.
                contexts = [
                    f"[{h.fields['date']}] {h.text}" if h.fields.get("date") else h.text
                    for h in hits
                ]
                question_date = record.get("question_date")
                question = (
                    f"{record['question']} (question asked on {question_date})"
                    if question_date
                    else record["question"]
                )
                answer = await config.reader.answer(question, contexts)
                # Grade against the same date-anchored question the reader saw, so
                # the judge has the temporal anchor too and doesn't mismark
                # temporal items.
                correct = await config.judge.grade(question, record["answer"], answer)
                if correct:
                    stats.qa_correct += 1
                    qa_correct += 1

            try:
                await retriever.delete([c.id for c in chunks])
            except Exception:
                pass
            try:
                await retriever.drop_index()
            except Exception:
                pass

            done = i + 1
            # Progress heartbeat: emit the record index and cumulative wall-clock
            # every 10 records (and on the last one) so a long run is observable
            # and a stalled request is obvious from the elapsed gap.
            if done % 10 == 0 or done == len(sliced):
                elapsed = time.monotonic() - started_at
                print(
                    f"[progress] record {done}/{len(sliced)}  elapsed {elapsed:.0f}s",
                    flush=True,
                )
    finally:
        await config.embedder.flush()

    return EvalSummary(
        total=total,
        recall_hits=recall_hits,
        recall_at_k=recall_hits / total if total > 0 else 0,
        qa_run=qa_run,
        qa_correct=qa_correct,
        qa_accuracy=qa_correct / total if qa_run and total > 0 else 0,
        k=config.k,
        total_chunks=total_chunks,
        by_type=by_type,
    )


def format_summary(summary: EvalSummary) -> str:
    lines: list[str] = []

    def pct(n: float) -> str:
        return f"{n * 100:.1f}%"

    lines.append("")
    lines.append(
        f"Records: {summary.total}   Chunks indexed: {summary.total_chunks}   k={summary.k}"
    )
    lines.append("")

    header = (
        "question_type                         n   recall@k   QA-acc"
        if summary.qa_run
        else "question_type                         n   recall@k"
    )
    lines.append(header)
    lines.append("-" * len(header))

    rows = sorted(summary.by_type.values(), key=lambda s: s.type)
    for row in rows:
        recall = pct(row.recall_hits / row.total if row.total > 0 else 0)
        base = f"{row.type.ljust(36)} {str(row.total).rjust(3)}   {recall.rjust(8)}"
        if summary.qa_run:
            lines.append(f"{base}   {pct(row.qa_correct / row.total).rjust(6)}")
        else:
            lines.append(base)

    lines.append("-" * len(header))
    overall = (
        f"{'OVERALL'.ljust(36)} {str(summary.total).rjust(3)}   {pct(summary.recall_at_k).rjust(8)}"
    )
    if summary.qa_run:
        lines.append(f"{overall}   {pct(summary.qa_accuracy).rjust(6)}")
    else:
        lines.append(overall)
    lines.append("")
    return "\n".join(lines)
