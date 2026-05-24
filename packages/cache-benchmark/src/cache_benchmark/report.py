"""
Markdown report generator for cache benchmark results.

Usage:
    python -m cache_benchmark.report <results_dir> <output_path>
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path


def _sparkline(values: list[float]) -> str:
    """Render a simple ASCII sparkline for a list of floats."""
    if not values:
        return ""
    bars = " ▁▂▃▄▅▆▇█"
    lo, hi = min(values), max(values)
    span = hi - lo or 1.0
    return "".join(bars[round((v - lo) / span * (len(bars) - 1))] for v in values)


def generate_report(results_dir: Path, output_path: Path) -> None:
    summary_files = list(results_dir.glob("summary_*.json"))
    if not summary_files:
        print("No summary_*.json files found in", results_dir)
        return

    lines: list[str] = []
    lines.append("<!--")
    lines.append("  Licensed under the Apache License, Version 2.0.")
    lines.append("  See https://www.apache.org/licenses/LICENSE-2.0")
    lines.append("-->")
    lines.append("")
    lines.append(f"# Cache Benchmark Report")
    lines.append("")
    lines.append(f"**Date:** {date.today().isoformat()}  ")
    lines.append(f"**Embedding model:** sentence-transformers/all-MiniLM-L6-v2  ")
    lines.append("")

    for summary_file in sorted(summary_files):
        dataset_name = summary_file.stem.replace("summary_", "")
        summary = json.loads(summary_file.read_text())

        # Count total pairs from one of the detailed result files
        total_pairs = "?"
        detail_files = list(results_dir.glob(f"*_{dataset_name}_*.json"))
        for df in detail_files:
            try:
                d = json.loads(df.read_text())
                if "results" in d:
                    total_pairs = len(d["results"])
                    break
            except Exception:
                pass

        lines.append(f"## Dataset: {dataset_name}")
        lines.append("")
        lines.append(f"**Total pairs:** {total_pairs}  ")
        lines.append("")
        lines.append("| Adapter | Threshold | Hit Rate | Precision | Recall | F1 | FPR | p95 Latency (ms) |")
        lines.append("|---------|-----------|----------|-----------|--------|----|-----|-----------------|")

        for key, m in sorted(summary.items()):
            parts = key.rsplit("_", 1)
            adapter_name = parts[0] if len(parts) == 2 else key
            threshold = parts[1] if len(parts) == 2 else "?"
            lines.append(
                f"| {adapter_name} | {threshold} "
                f"| {m['hit_rate']:.3f} "
                f"| {m['precision']:.3f} "
                f"| {m['recall']:.3f} "
                f"| {m['f1']:.3f} "
                f"| {m['false_positive_rate']:.3f} "
                f"| {m['p95_latency_ms']:.1f} |"
            )

        lines.append("")

        # Per-adapter F1 sparkline across thresholds
        lines.append("### F1 by threshold")
        lines.append("")
        adapter_thresholds: dict[str, list[tuple[float, float]]] = {}
        for key, m in summary.items():
            parts = key.rsplit("_", 1)
            if len(parts) == 2:
                adapter_name, threshold_str = parts
                try:
                    adapter_thresholds.setdefault(adapter_name, []).append((float(threshold_str), m["f1"]))
                except ValueError:
                    pass

        for adapter_name, th_f1 in sorted(adapter_thresholds.items()):
            th_f1.sort()
            f1_values = [f1 for _, f1 in th_f1]
            spark = _sparkline(f1_values)
            lines.append(f"**{adapter_name}:** `{spark}` (thresholds: {[t for t, _ in th_f1]})")
            lines.append("")

        # Best F1 summary
        lines.append("### Best F1 per adapter")
        lines.append("")
        lines.append("```")
        for adapter_name, th_f1 in sorted(adapter_thresholds.items()):
            best_t, best_f1 = max(th_f1, key=lambda x: x[1])
            lines.append(f"{adapter_name:12s}  F1={best_f1:.4f} at threshold={best_t}")
        lines.append("```")
        lines.append("")

    output_path.write_text("\n".join(lines))
    print(f"Report written to {output_path}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python -m cache_benchmark.report <results_dir> <output_path>")
        sys.exit(1)
    generate_report(Path(sys.argv[1]), Path(sys.argv[2]))
