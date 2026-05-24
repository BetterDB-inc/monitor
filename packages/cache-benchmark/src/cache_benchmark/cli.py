from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import click

from cache_benchmark.adapters.base import CacheAdapter
from cache_benchmark.harness import run_replay
from cache_benchmark.metrics import compute_metrics


def _make_judge_log_writer(log_path: Path):
    """Return a callable that appends one JSON line per judge invocation."""
    log_path.parent.mkdir(parents=True, exist_ok=True)
    # Truncate on first open so reruns don't accumulate stale data
    log_path.write_text("")

    def write(record: dict) -> None:
        with open(log_path, "a") as f:
            f.write(json.dumps(record) + "\n")

    return write


def _build_adapter(
    adapter_name: str,
    threshold: float,
    embedding_model: str,
    redis_url: str,
    mode: str,
    debug_judge: bool = False,
    judge_log_writer=None,
) -> CacheAdapter:
    if adapter_name == "betterdb":
        from cache_benchmark.adapters.betterdb import BetterDBAdapter
        return BetterDBAdapter(
            threshold=threshold, embedding_model=embedding_model, redis_url=redis_url,
            mode=mode, debug_judge=debug_judge, judge_log_writer=judge_log_writer,
        )
    if adapter_name == "redisvl":
        from cache_benchmark.adapters.redisvl_adapter import RedisVLAdapter
        return RedisVLAdapter(
            threshold=threshold, embedding_model=embedding_model, redis_url=redis_url,
            mode=mode, debug_judge=debug_judge, judge_log_writer=judge_log_writer,
        )
    if adapter_name == "gptcache":
        from cache_benchmark.adapters.gptcache_adapter import GPTCacheAdapter
        return GPTCacheAdapter(threshold=threshold, embedding_model=embedding_model, redis_url=redis_url, mode=mode)
    raise ValueError(f"Unknown adapter: {adapter_name}")


def _load_dataset(dataset_name: str, limit: int):
    if dataset_name == "vcache_lmarena":
        from cache_benchmark.datasets.vcache_lmarena import load_vcache_lmarena
        return load_vcache_lmarena(limit=limit)
    if dataset_name == "paws_wiki":
        from cache_benchmark.datasets.paws_wiki import load_paws_wiki
        return load_paws_wiki(limit=limit)
    raise ValueError(f"Unknown dataset: {dataset_name}")


async def _run_single(
    adapter_name: str,
    dataset_name: str,
    threshold: float,
    embedding_model: str,
    redis_url: str,
    limit: int,
    output_dir: Path,
    mode: str,
    debug_judge: bool = False,
):
    pairs = _load_dataset(dataset_name, limit)

    judge_log_writer = None
    if debug_judge:
        log_path = output_dir / f"judge_log_{adapter_name}_{mode}_{dataset_name}_{threshold}.jsonl"
        judge_log_writer = _make_judge_log_writer(log_path)

    adapter = _build_adapter(
        adapter_name, threshold, embedding_model, redis_url, mode,
        debug_judge=debug_judge, judge_log_writer=judge_log_writer,
    )

    # Transparency log
    features = adapter.enabled_features()
    click.echo(f"[{adapter_name} {mode}] enabled: {', '.join(features)}")
    if debug_judge:
        click.echo(f"[{adapter_name} {mode}] debug-judge ON → {log_path}")

    try:
        results = await run_replay(adapter, pairs)
    finally:
        await adapter.close()

    metrics = compute_metrics(results)

    out_file = output_dir / f"{adapter_name}_{mode}_{dataset_name}_{threshold}.json"
    out_file.write_text(json.dumps({
        "adapter": adapter_name,
        "mode": mode,
        "dataset": dataset_name,
        "threshold": threshold,
        "embedding_model": embedding_model,
        "enabled_features": features,
        "metrics": metrics.model_dump(),
        "results": [r.model_dump() for r in results],
    }, indent=2))

    click.echo(
        f"[{adapter_name} {mode}] threshold={threshold} "
        f"F1={metrics.f1:.4f} precision={metrics.precision:.4f} recall={metrics.recall:.4f}"
    )
    return (adapter_name, threshold), metrics


@click.command()
@click.option("--adapter", type=click.Choice(["betterdb", "redisvl", "gptcache", "all"]), default="betterdb", show_default=True)
@click.option("--dataset", type=click.Choice(["vcache_lmarena", "paws_wiki"]), required=True)
@click.option("--limit", default=1000, show_default=True, help="Max pairs per adapter/threshold run (keep ≤1000 for valkey-bundle stability)")
@click.option("--thresholds", default="0.05,0.10,0.15,0.20,0.25,0.30,0.35,0.40,0.45", show_default=True)
@click.option("--embedding-model", default="sentence-transformers/all-MiniLM-L6-v2", show_default=True)
@click.option("--redis-url", default="redis://localhost:6381", show_default=True, help="Valkey/Redis URL (must have valkey-search module)")
@click.option("--output", default="./results", show_default=True, help="Output directory")
@click.option("--mode", type=click.Choice(["bare", "local", "full"]), default="bare", show_default=True,
              help=(
                  "bare: cosine-distance threshold only, no external APIs (reproducible baseline). "
                  "local: native library quality features that require no external APIs "
                  "(BetterDB: k=3 rerank; GPTCache: SBERT crossencoder; RedisVL: unchanged). "
                  "full: all native features including paid API integrations "
                  "(BetterDB adds LLM judge via OPENAI_API_KEY; GPTCache uses Cohere rerank via COHERE_API_KEY)."
              ))
@click.option("--debug-judge", is_flag=True, default=False,
              help=(
                  "Investigation flag: wire an LLM judge (gpt-4o-mini) onto every cosine hit "
                  "for BetterDB (full mode) and RedisVL (any mode), and write every invocation "
                  "to judge_log_{adapter}_{mode}_{dataset}_{threshold}.jsonl in --output. "
                  "Requires OPENAI_API_KEY. Changes hit/miss verdicts. Not for production runs."
              ))
def main(adapter, dataset, limit, thresholds, embedding_model, redis_url, output, mode, debug_judge):
    """Run cache benchmark replay harness."""
    output_dir = Path(output)
    output_dir.mkdir(parents=True, exist_ok=True)

    if debug_judge and not os.environ.get("OPENAI_API_KEY"):
        raise click.ClickException(
            "--debug-judge requires OPENAI_API_KEY to be set in the environment."
        )

    threshold_list = [float(t.strip()) for t in thresholds.split(",")]
    adapter_names = ["betterdb", "redisvl", "gptcache"] if adapter == "all" else [adapter]

    summary: dict[str, dict] = {}

    async def _run_all():
        for adapter_name in adapter_names:
            for threshold in threshold_list:
                key, metrics = await _run_single(
                    adapter_name=adapter_name,
                    dataset_name=dataset,
                    threshold=threshold,
                    embedding_model=embedding_model,
                    redis_url=redis_url,
                    limit=limit,
                    output_dir=output_dir,
                    mode=mode,
                    debug_judge=debug_judge,
                )
                summary[f"{key[0]}_{key[1]}"] = metrics.model_dump()

    asyncio.run(_run_all())

    summary_file = output_dir / f"summary_{mode}_{dataset}.json"
    summary_file.write_text(json.dumps(summary, indent=2))
    click.echo(f"\nSummary written to {summary_file}")
