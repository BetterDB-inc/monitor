from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from .dataset import load_dataset
from .embed import create_mock_embedder, create_openai_embedder
from .judge import create_mock_judge, create_openai_judge
from .reader import create_mock_reader, create_openai_reader
from .runner import RunConfig, format_summary, run_eval
from .store import create_mock_store, create_real_store
from .types import ChunkMode, Embedder, Judge, Reader, Store


def _env_int(name: str, fallback: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return fallback
    try:
        value = int(raw)
    except ValueError:
        return fallback
    return value if value > 0 else fallback


async def main() -> None:
    api_key = os.environ.get("OPENAI_API_KEY")
    valkey_url = os.environ.get("VALKEY_URL") or "redis://:devpassword@localhost:6384"
    data_path = os.environ.get("LONGMEMEVAL_DATA")
    limit = _env_int("LONGMEMEVAL_LIMIT", 20)
    k = _env_int("LONGMEMEVAL_K", 10)
    chunk_mode: ChunkMode = "turn" if os.environ.get("LONGMEMEVAL_CHUNK") == "turn" else "session"
    qa = os.environ.get("LONGMEMEVAL_QA") == "1"

    cache_path = str(Path(__file__).parent / ".cache" / "embeddings.json")

    # EMBEDDER seam.
    embedder: Embedder
    if api_key:
        embedder = create_openai_embedder(api_key, cache_path)
    else:
        embedder = create_mock_embedder()

    # STORE seam. Everything after the store is opened runs under try/finally so
    # a failure in dataset loading or the banner prints still closes the live
    # Valkey connection rather than leaking it.
    store: Optional[Store] = await create_real_store(valkey_url)
    if store is None:
        store = create_mock_store()

    try:
        # READER + JUDGE seams (Tier 2 only).
        reader: Optional[Reader] = None
        judge: Optional[Judge] = None
        if qa:
            if api_key:
                reader = create_openai_reader(api_key)
                judge = create_openai_judge(api_key)
            else:
                reader = create_mock_reader()
                judge = create_mock_judge()

        records, source = load_dataset(data_path)

        if qa:
            tier = "Tier 2 (retrieval + QA)"
        elif store.is_real or embedder.dims == 1536:
            tier = "Tier 1 (real recall)"
        else:
            tier = "Tier 0 (offline)"

        print("=" * 64)
        print("LongMemEval retrieval harness — betterdb-retrieval")
        print("=" * 64)
        print(f"tier      : {tier}")
        print(f"embedder  : {embedder.name}  (dims={embedder.dims})")
        unreachable = "" if store.is_real else "  (Valkey unreachable → mock)"
        print(f"store     : {store.name}{unreachable}")
        print(f"reader    : {'disabled' if reader is None else reader.name}")
        print(f"judge     : {'disabled' if judge is None else judge.name}")
        print(f"dataset   : {source}  ({len(records)} records)")
        print(f"params    : limit={limit} k={k} chunk={chunk_mode} qa={qa}")
        print("=" * 64)

        summary = await run_eval(
            RunConfig(
                records=records,
                embedder=embedder,
                store=store,
                reader=reader,
                judge=judge,
                k=k,
                chunk_mode=chunk_mode,
                limit=limit,
            )
        )
        print(format_summary(summary))
    finally:
        await store.close()
