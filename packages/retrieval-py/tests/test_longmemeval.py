from __future__ import annotations

from eval.longmemeval.dataset import load_fixture
from eval.longmemeval.embed import create_mock_embedder
from eval.longmemeval.judge import create_mock_judge
from eval.longmemeval.reader import create_mock_reader
from eval.longmemeval.runner import RunConfig, run_eval
from eval.longmemeval.store import create_mock_store


def _config(**overrides) -> RunConfig:
    base = {
        "records": load_fixture(),
        "embedder": create_mock_embedder(),
        "store": create_mock_store(),
        "reader": None,
        "judge": None,
        "k": 2,
        "chunk_mode": "session",
        "limit": 20,
    }
    base.update(overrides)
    return RunConfig(**base)


# Tier 0: fully offline (mock store + hashed embed), no keys/network/Docker.
async def test_retrieves_evidence_session_above_threshold() -> None:
    records = load_fixture()
    summary = await run_eval(_config(records=records))

    assert summary.total == len(records)
    # Lexical mock embedding must rank the evidence session within the top-k.
    assert summary.recall_at_k >= 0.75


async def test_is_deterministic_across_runs() -> None:
    a = await run_eval(_config())
    b = await run_eval(_config())
    assert a.recall_hits == b.recall_hits
    assert a.recall_at_k == b.recall_at_k


async def test_runs_mock_reader_judge_qa_path() -> None:
    summary = await run_eval(_config(reader=create_mock_reader(), judge=create_mock_judge()))
    assert summary.qa_run is True
    # Mock reader echoes the top hit; the evidence text contains the gold answer.
    assert summary.qa_accuracy >= 0.75


async def test_supports_per_turn_chunking() -> None:
    records = load_fixture()
    summary = await run_eval(_config(records=records, k=3, chunk_mode="turn"))
    assert summary.total == len(records)
    assert summary.total_chunks > len(records)
