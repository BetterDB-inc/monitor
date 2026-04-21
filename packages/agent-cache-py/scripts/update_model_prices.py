#!/usr/bin/env python3
"""
Fetches model pricing from LiteLLM's model_prices_and_context_window.json
and writes betterdb_agent_cache/default_cost_table.py.

Run via: python scripts/update_model_prices.py
"""
from __future__ import annotations

import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PRICES_URL = (
    "https://raw.githubusercontent.com/BerriAI/litellm/main"
    "/model_prices_and_context_window.json"
)
COMMITS_URL = "https://api.github.com/repos/BerriAI/litellm/commits/main"

OUT_FILE = Path(__file__).parent.parent / "betterdb_agent_cache" / "default_cost_table.py"


def fetch_json(url: str) -> object:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "betterdb-agent-cache-pricing-updater"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def main() -> None:
    # Fetch both sources
    try:
        prices = fetch_json(PRICES_URL)
    except Exception as exc:
        print(f"Error fetching prices: {exc}", file=sys.stderr)
        sys.exit(1)

    try:
        commits = fetch_json(COMMITS_URL)
    except Exception as exc:
        print(f"Error fetching commits: {exc}", file=sys.stderr)
        sys.exit(1)

    # Extract short SHA
    try:
        sha = commits[0]["sha"] if isinstance(commits, list) else commits["sha"]
        short_sha = sha[:7]
    except (KeyError, IndexError, TypeError) as exc:
        print(f"Error extracting commit SHA: {exc}", file=sys.stderr)
        sys.exit(1)

    # Filter and transform entries
    try:
        entries: list[tuple[str, float, float]] = []
        for key, val in prices.items():
            if key == "sample_spec" or key.startswith("_"):
                continue
            if not isinstance(val, dict):
                continue
            input_cost = val.get("input_cost_per_token")
            output_cost = val.get("output_cost_per_token")
            if not (
                isinstance(input_cost, (int, float))
                and isinstance(output_cost, (int, float))
                and input_cost > 0
                and output_cost > 0
            ):
                continue
            entries.append((key, input_cost * 1000, output_cost * 1000))
    except Exception as exc:
        print(f"Error processing price data: {exc}", file=sys.stderr)
        sys.exit(1)

    # Sort keys alphabetically for stable diffs
    entries.sort(key=lambda e: e[0])

    count = len(entries)
    fetched_at = datetime.now(timezone.utc).isoformat()

    # Build the Python source
    lines = [
        "# AUTO-GENERATED. Do not edit by hand.",
        "# Source: https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json",
        f"# Commit: {short_sha}",
        f"# Fetched: {fetched_at}",
        f"# Entries: {count}",
        "#",
        "# Regenerate: python scripts/update_model_prices.py",
        "from __future__ import annotations",
        "",
        "from .types import ModelCost",
        "",
        "DEFAULT_COST_TABLE: dict[str, ModelCost] = {",
    ]

    for key, input_per_1k, output_per_1k in entries:
        escaped = key.replace('"', '\\"')
        lines.append(
            f'    "{escaped}": ModelCost(input_per_1k={input_per_1k}, output_per_1k={output_per_1k}),'
        )

    lines.append("}")
    lines.append("")

    try:
        OUT_FILE.write_text("\n".join(lines), encoding="utf-8")
    except Exception as exc:
        print(f"Error writing {OUT_FILE}: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"Wrote {count} entries to betterdb_agent_cache/default_cost_table.py (commit {short_sha})")


if __name__ == "__main__":
    main()
