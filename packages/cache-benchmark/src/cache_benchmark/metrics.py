from __future__ import annotations

import numpy as np

from cache_benchmark.types import Metrics, ReplayResult


def compute_metrics(results: list[ReplayResult]) -> Metrics:
    tp = sum(1 for r in results if r.hit and r.is_semantic_match)
    fp = sum(1 for r in results if r.hit and not r.is_semantic_match)
    tn = sum(1 for r in results if not r.hit and not r.is_semantic_match)
    fn = sum(1 for r in results if not r.hit and r.is_semantic_match)
    total = len(results)

    hit_rate = (tp + fp) / total if total > 0 else 0.0
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    fpr = fp / (fp + tn) if (fp + tn) > 0 else 0.0

    latencies = np.array([r.latency_ms for r in results], dtype=float)
    p50 = float(np.percentile(latencies, 50)) if len(latencies) > 0 else 0.0
    p95 = float(np.percentile(latencies, 95)) if len(latencies) > 0 else 0.0
    p99 = float(np.percentile(latencies, 99)) if len(latencies) > 0 else 0.0

    hit_sims = [r.similarity_score for r in results if r.hit and r.similarity_score is not None]
    mean_sim = float(np.mean(hit_sims)) if hit_sims else None

    return Metrics(
        total=total,
        true_positives=tp,
        false_positives=fp,
        true_negatives=tn,
        false_negatives=fn,
        hit_rate=hit_rate,
        precision=precision,
        recall=recall,
        f1=f1,
        false_positive_rate=fpr,
        p50_latency_ms=p50,
        p95_latency_ms=p95,
        p99_latency_ms=p99,
        mean_similarity_on_hits=mean_sim,
    )


if __name__ == "__main__":
    import json
    import sys
    from pathlib import Path

    path = Path(sys.argv[1])
    data = json.loads(path.read_text())
    raw = data.get("results", data)
    results = [ReplayResult(**r) for r in raw]
    print(compute_metrics(results).model_dump())
