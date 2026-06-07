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
    trajectory_writer=None,
    rerank_compare: str = "legacy",
    rerank_k: int = 3,
    cosine_weight: float = 0.7,
) -> CacheAdapter:
    if adapter_name == "betterdb":
        from cache_benchmark.adapters.betterdb import BetterDBAdapter
        return BetterDBAdapter(
            threshold=threshold, embedding_model=embedding_model, redis_url=redis_url,
            mode=mode, debug_judge=debug_judge, judge_log_writer=judge_log_writer,
            trajectory_writer=trajectory_writer, rerank_compare=rerank_compare,
            rerank_k=rerank_k, cosine_weight=cosine_weight,
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


def _load_dataset(dataset_name: str, limit: int, match_threshold: float = 0.6):
    if dataset_name == "vcache_lmarena":
        from cache_benchmark.datasets.vcache_lmarena import load_vcache_lmarena
        return load_vcache_lmarena(limit=limit)
    if dataset_name == "paws_wiki":
        from cache_benchmark.datasets.paws_wiki import load_paws_wiki
        return load_paws_wiki(limit=limit)
    if dataset_name == "stsb":
        from cache_benchmark.datasets.stsb import load_stsb
        return load_stsb(match_threshold=match_threshold, limit=limit)
    if dataset_name == "sick":
        from cache_benchmark.datasets.sick import load_sick
        return load_sick(match_threshold=match_threshold, limit=limit)
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
    match_threshold: float = 0.6,
    debug_judge: bool = False,
    rerank_compare: str = "legacy",
    rerank_k: int = 3,
    cosine_weight: float = 0.7,
    store_mode: str = "paired",
):
    pairs = _load_dataset(dataset_name, limit, match_threshold=match_threshold)

    judge_log_writer = None
    if debug_judge:
        log_path = output_dir / f"judge_log_{adapter_name}_{mode}_{dataset_name}_{threshold}.jsonl"
        judge_log_writer = _make_judge_log_writer(log_path)

    # Autotune trajectory writer — one line per check() call recording the
    # effective threshold at the time of the check plus hit/miss and recommendation.
    trajectory_writer = None
    if mode in ("autotune", "autotune-full"):
        traj_path = output_dir / f"threshold_trajectory_{adapter_name}_{mode}_{dataset_name}_{threshold}.jsonl"
        trajectory_writer = _make_judge_log_writer(traj_path)  # same append-JSONL pattern

    adapter = _build_adapter(
        adapter_name, threshold, embedding_model, redis_url, mode,
        debug_judge=debug_judge, judge_log_writer=judge_log_writer,
        trajectory_writer=trajectory_writer, rerank_compare=rerank_compare,
        rerank_k=rerank_k, cosine_weight=cosine_weight,
    )

    # Transparency log
    features = adapter.enabled_features()
    click.echo(f"[{adapter_name} {mode}] enabled: {', '.join(features)}")
    if debug_judge:
        click.echo(f"[{adapter_name} {mode}] debug-judge ON → {log_path}")
    if mode in ("autotune", "autotune-full"):
        click.echo(f"[{adapter_name} {mode}] trajectory → {traj_path}")

    try:
        results = await run_replay(adapter, pairs, store_mode=store_mode)
    finally:
        await adapter.close()

    metrics = compute_metrics(results)

    # In autotune mode the "threshold" in the filename is the *initial* value;
    # the effective threshold drifts during the run (captured in the trajectory file).
    out_file = output_dir / f"{adapter_name}_{mode}_{dataset_name}_{threshold}.json"

    # Read final effective threshold from adapter (may differ from initial in autotune mode)
    final_threshold = getattr(adapter, "current_threshold", threshold)

    out_file.write_text(json.dumps({
        "adapter": adapter_name,
        "mode": mode,
        "dataset": dataset_name,
        "initial_threshold": threshold,
        "final_threshold": final_threshold,
        "embedding_model": embedding_model,
        "enabled_features": features,
        "metrics": metrics.model_dump(),
        "results": [r.model_dump() for r in results],
    }, indent=2))

    threshold_note = (
        f" (initial={threshold}, final={final_threshold:.4f})"
        if mode in ("autotune", "autotune-full") and final_threshold != threshold
        else f" threshold={threshold}"
    )
    click.echo(
        f"[{adapter_name} {mode}]{threshold_note} "
        f"F1={metrics.f1:.4f} precision={metrics.precision:.4f} recall={metrics.recall:.4f}"
    )
    return (adapter_name, threshold), metrics


@click.command()
@click.option("--adapter", type=click.Choice(["betterdb", "redisvl", "gptcache", "all"]), default="betterdb", show_default=True)
@click.option("--dataset", type=click.Choice(["vcache_lmarena", "paws_wiki", "stsb", "sick"]), required=True)
@click.option("--limit", default=1000, show_default=True, help="Max pairs per adapter/threshold run (keep ≤1000 for valkey-bundle stability)")
@click.option("--thresholds", default="0.05,0.10,0.15,0.20,0.25,0.30,0.35,0.40,0.45", show_default=True)
@click.option("--embedding-model", default="sentence-transformers/all-MiniLM-L6-v2", show_default=True)
@click.option("--redis-url", default="redis://localhost:6381", show_default=True, help="Valkey/Redis URL (must have valkey-search module)")
@click.option("--output", default="./results", show_default=True, help="Output directory")
@click.option("--mode", type=click.Choice(["bare", "local", "full", "autotune", "autotune-full"]), default="bare", show_default=True,
              help=(
                  "bare: cosine-distance threshold only, no external APIs (reproducible baseline). "
                  "local: native library quality features that require no external APIs "
                  "(BetterDB: k=3 rerank; GPTCache: SBERT crossencoder; RedisVL: unchanged). "
                  "full: all native features including paid API integrations "
                  "(BetterDB adds LLM judge via OPENAI_API_KEY; GPTCache uses Cohere rerank via COHERE_API_KEY). "
                  "autotune: BetterDB-specific threshold autotuning via Monitor API (bare cosine + threshold evolution). "
                  "autotune-full: autotune + rerank + LLM judge (requires OPENAI_API_KEY + Monitor env vars)."
              ))
@click.option("--match-threshold", default=0.6, show_default=True,
              help=(
                  "STSb only: normalized similarity score (0-1) at or above which a pair "
                  "is considered a semantic match. 0.6 = 3.0/5.0, the boundary between "
                  "'roughly equivalent' and 'not equivalent' in STS annotation guidelines. "
                  "Ignored for other datasets."
              ))
@click.option("--debug-judge", is_flag=True, default=False,
              help=(
                  "Investigation flag: wire an LLM judge (gpt-4o-mini) onto every cosine hit "
                  "for BetterDB (full mode) and RedisVL (any mode), and write every invocation "
                  "to judge_log_{adapter}_{mode}_{dataset}_{threshold}.jsonl in --output. "
                  "Requires OPENAI_API_KEY. Changes hit/miss verdicts. Not for production runs."
              ))
@click.option("--rerank-compare", type=click.Choice(["legacy", "prompt", "response"]), default="legacy", show_default=True,
              help="BetterDB rerank axis: 'legacy' = old inline rerank, 'prompt' or 'response' = new built-in factory.")
@click.option("--rerank-k", default=3, show_default=True, help="Number of candidates for reranking (BetterDB only).")
@click.option("--cosine-weight", default=0.7, show_default=True, help="Cosine weight in rerank blend (overlap = 1 - this). BetterDB built-in only.")
@click.option("--store-mode", type=click.Choice(["paired", "dense"]), default="paired", show_default=True,
              help="paired: one entry per pair (classic). dense: store all unique prompts, creating entity-confusable neighbors.")
def main(adapter, dataset, limit, thresholds, embedding_model, redis_url, output, mode, match_threshold, debug_judge, rerank_compare, rerank_k, cosine_weight, store_mode):
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
            if mode in ("autotune", "autotune-full") and adapter_name != "betterdb":
                click.echo(
                    f"Skipping {adapter_name}: {mode} is BetterDB-specific "
                    f"(RedisVL and GPTCache do not ship native autotuning)."
                )
                continue
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
                    match_threshold=match_threshold,
                    debug_judge=debug_judge,
                    rerank_compare=rerank_compare,
                    rerank_k=rerank_k,
                    cosine_weight=cosine_weight,
                    store_mode=store_mode,
                )
                summary[f"{key[0]}_{key[1]}"] = metrics.model_dump()

    asyncio.run(_run_all())

    summary_file = output_dir / f"summary_{mode}_{dataset}.json"
    summary_file.write_text(json.dumps(summary, indent=2))
    click.echo(f"\nSummary written to {summary_file}")
