#!/usr/bin/env python3
"""
Interleaved benchmark runner. Randomizes baseline/monitored pairs
to eliminate warm-up bias.
"""

import subprocess
import random
import time
import json
import os
import sys
import shutil
import argparse
from pathlib import Path
from datetime import datetime
import urllib.request

from dotenv import load_dotenv

# Load .env from project root
load_dotenv(Path(__file__).parent.parent / ".env")

CONFIG = {
    "betterdb_url": os.getenv("BETTERDB_URL", "http://localhost:3002"),
    "betterdb_container": os.getenv("BETTERDB_CONTAINER", "benchmark-betterdb"),
    "valkey_port": os.getenv("VALKEY_PORT", "6382"),
    "valkey_password": os.getenv("VALKEY_PASSWORD", ""),
    "benchmark_config": "configs/betterdb-quick.json",
    "stabilization_time": 10,  # seconds after starting/stopping BetterDB
}


def log(msg: str):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def is_betterdb_running() -> bool:
    try:
        req = urllib.request.Request(f"{CONFIG['betterdb_url']}/api/health")
        with urllib.request.urlopen(req, timeout=3) as r:
            data = json.loads(r.read())
            return data.get("status") == "connected"
    except:
        return False


def stop_betterdb():
    log("Stopping BetterDB...")
    subprocess.run(["docker", "stop", CONFIG["betterdb_container"]],
                   capture_output=True, check=False)
    for _ in range(30):
        if not is_betterdb_running():
            time.sleep(CONFIG["stabilization_time"])
            return
        time.sleep(1)
    raise RuntimeError("BetterDB did not stop")


def start_betterdb():
    log("Starting BetterDB...")
    subprocess.run(["docker", "start", CONFIG["betterdb_container"]],
                   capture_output=True, check=False)
    for _ in range(60):
        if is_betterdb_running():
            time.sleep(CONFIG["stabilization_time"])
            return
        time.sleep(1)
    raise RuntimeError("BetterDB did not start")


def set_condition(condition: str):
    if condition == "baseline":
        if is_betterdb_running():
            stop_betterdb()
    else:
        if not is_betterdb_running():
            start_betterdb()


def run_single_benchmark(results_dir: Path, run_id: str, config_file: str) -> bool:
    run_dir = results_dir / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    with open(config_file) as f:
        configs = json.load(f)

    if not configs:
        raise ValueError("Empty config file")

    config = configs[0]
    cmd = [
        "valkey-benchmark",
        "-h", "localhost",
        "-p", CONFIG["valkey_port"],
        "-n", str(config.get("requests", [100000])[0]),
        "-c", str(config.get("clients", [50])[0] if "clients" in config else 50),
        "-d", str(config.get("data_sizes", [64])[0]),
        "-t", ",".join(config.get("commands", ["SET", "GET"])),
        "--csv"
    ]

    # Add password if configured
    if CONFIG["valkey_password"]:
        cmd.extend(["-a", CONFIG["valkey_password"]])

    log(f"  Running benchmark → {run_id}")
    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        log(f"  WARNING: Benchmark failed: {result.stderr[:200]}")
        return False

    output_file = run_dir / "results.csv"
    with open(output_file, "w") as f:
        f.write(result.stdout)

    metrics = []
    for line in result.stdout.strip().split('\n'):
        if line and not line.startswith('#'):
            parts = line.split(',')
            if len(parts) >= 2:
                try:
                    metrics.append({
                        "command": parts[0].strip('"'),
                        "throughput": float(parts[1].strip('"')),
                    })
                except (ValueError, IndexError):
                    pass

    with open(run_dir / "metrics.json", "w") as f:
        json.dump(metrics, f, indent=2)

    return True


def merge_metrics(results_dir: Path, condition: str, run_dirs: list) -> Path:
    command_values = {}

    for run_dir in run_dirs:
        metrics_file = results_dir / run_dir / "metrics.json"
        if not metrics_file.exists():
            continue

        try:
            with open(metrics_file) as f:
                metrics = json.load(f)

            for metric in metrics:
                cmd = metric["command"]
                throughput = metric["throughput"]

                if cmd not in command_values:
                    command_values[cmd] = []
                command_values[cmd].append(throughput)

        except Exception as e:
            log(f"  Warning: Could not read {metrics_file}: {e}")

    import math

    summary = {}
    for cmd, values in command_values.items():
        n = len(values)
        mean = sum(values) / n if n > 0 else 0

        if n > 1:
            variance = sum((x - mean) ** 2 for x in values) / n
            stdev = math.sqrt(variance)
            cv = (stdev / mean * 100) if mean > 0 else 0
        else:
            stdev = 0
            cv = 0

        summary[cmd] = {
            "count": n,
            "mean": mean,
            "stdev": stdev,
            "cv": cv,
            "min": min(values) if values else 0,
            "max": max(values) if values else 0,
            "values": values
        }

    output_file = results_dir / f"{condition}_metrics.json"
    with open(output_file, "w") as f:
        json.dump(summary, f, indent=2)

    log(f"  Merged {sum(len(v['values']) for v in summary.values())} measurements → {output_file}")
    return output_file


def generate_comparison(baseline_file: Path, monitored_file: Path, output_dir: Path):
    output_dir.mkdir(parents=True, exist_ok=True)

    with open(baseline_file) as f:
        baseline = json.load(f)

    with open(monitored_file) as f:
        monitored = json.load(f)

    report = []
    report.append("# BetterDB Performance Impact - Interleaved Benchmark\n")
    report.append(f"**Generated**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
    report.append(f"**Configuration**: {CONFIG['benchmark_config']}\n\n")

    report.append("## Results\n\n")

    for cmd in sorted(set(list(baseline.keys()) + list(monitored.keys()))):
        report.append(f"### {cmd}\n\n")

        if cmd not in baseline or cmd not in monitored:
            report.append("*Missing data for comparison*\n\n")
            continue

        b = baseline[cmd]
        m = monitored[cmd]

        overhead = ((b["mean"] - m["mean"]) / b["mean"] * 100) if b["mean"] > 0 else 0

        report.append(f"**Baseline**:\n")
        report.append(f"- Mean: {b['mean']:.2f} ± {b['stdev']:.2f} ops/sec\n")
        report.append(f"- CV: {b['cv']:.2f}%\n")
        report.append(f"- Range: [{b['min']:.2f}, {b['max']:.2f}]\n")
        report.append(f"- Runs: {b['count']}\n\n")

        report.append(f"**Monitored**:\n")
        report.append(f"- Mean: {m['mean']:.2f} ± {m['stdev']:.2f} ops/sec\n")
        report.append(f"- CV: {m['cv']:.2f}%\n")
        report.append(f"- Range: [{m['min']:.2f}, {m['max']:.2f}]\n")
        report.append(f"- Runs: {m['count']}\n\n")

        if overhead < 0:
            verdict = "faster (noise)"
        elif overhead < 5:
            verdict = "acceptable"
        elif overhead < 10:
            verdict = "marginal"
        else:
            verdict = "significant"

        report.append(f"**Overhead**: {overhead:+.2f}% ({verdict})\n\n")

    report_file = output_dir / "comparison.md"
    with open(report_file, "w") as f:
        f.write("".join(report))

    log(f"  Comparison report: {report_file}")
    return report_file


def main():
    parser = argparse.ArgumentParser(
        description="Interleaved BetterDB benchmark using valkey-benchmark"
    )
    parser.add_argument("--runs", type=int, default=5,
                        help="Number of runs per condition (default: 5)")
    parser.add_argument("--config", type=str, default="configs/betterdb-quick.json",
                        help="Benchmark config file")
    parser.add_argument("--output", type=str, default=None,
                        help="Output directory")
    args = parser.parse_args()

    CONFIG["benchmark_config"] = args.config

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = Path(args.output) if args.output else Path(f"betterdb-results/{timestamp}")
    output_dir.mkdir(parents=True, exist_ok=True)

    n_runs = args.runs
    total_runs = n_runs * 2

    log(f"=== Interleaved BetterDB Benchmark ===")
    log(f"Runs per condition: {n_runs}")
    log(f"Total runs: {total_runs}")
    log(f"Config: {CONFIG['benchmark_config']}")
    log(f"Output: {output_dir}")
    log(f"Valkey port: {CONFIG['valkey_port']}")

    schedule = []
    for i in range(n_runs):
        pair = [
            {"condition": "baseline", "run_id": f"baseline_{i:02d}"},
            {"condition": "monitored", "run_id": f"monitored_{i:02d}"},
        ]
        random.shuffle(pair)
        schedule.extend(pair)

    with open(output_dir / "schedule.json", "w") as f:
        json.dump(schedule, f, indent=2)

    log(f"\nSchedule:")
    for i, run in enumerate(schedule):
        log(f"  {i+1}. {run['condition']}")

    log(f"\n=== Running ===\n")

    baseline_runs = []
    monitored_runs = []
    current_condition = None

    for i, run in enumerate(schedule):
        log(f"[{i+1}/{total_runs}] {run['condition'].upper()}")
        if run["condition"] != current_condition:
            set_condition(run["condition"])
            current_condition = run["condition"]
        success = run_single_benchmark(output_dir, run["run_id"], CONFIG["benchmark_config"])

        if success:
            if run["condition"] == "baseline":
                baseline_runs.append(run["run_id"])
            else:
                monitored_runs.append(run["run_id"])

        log("")

    log("=== Merging ===")
    baseline_metrics = merge_metrics(output_dir, "baseline", baseline_runs)
    monitored_metrics = merge_metrics(output_dir, "monitored", monitored_runs)

    log("\n=== Comparison ===")
    comparison_dir = output_dir / "comparison"
    report_file = generate_comparison(baseline_metrics, monitored_metrics, comparison_dir)

    log("\n" + "=" * 60)
    log("RESULTS")
    log("=" * 60)
    log(f"Baseline runs:  {len(baseline_runs)}")
    log(f"Monitored runs: {len(monitored_runs)}")
    log(f"")
    log(f"Results: {output_dir}")
    log(f"Comparison: {report_file}")
    if report_file.exists():
        log("\n" + "=" * 60)
        print(report_file.read_text())


if __name__ == "__main__":
    main()
