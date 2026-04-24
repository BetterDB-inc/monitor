#!/usr/bin/env python3
"""
Fetches model pricing from LiteLLM's model_prices_and_context_window.json
and writes betterdb_semantic_cache/default_cost_table.py.

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

OUT_FILE = Path(__file__).parent.parent / "betterdb_semantic_cache" / "default_cost_table.py"


def fetch_json(url: str) -> object:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "betterdb-semantic-cache-pricing-updater"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def main() -> None:
    print("Fetching model prices from LiteLLM …")
    data = fetch_json(PRICES_URL)

    print("Fetching latest commit SHA …")
    try:
        commits = fetch_json(COMMITS_URL)
        sha = commits[0]["sha"][:7]  # type: ignore[index]
    except Exception:
        sha = "unknown"

    now = datetime.now(timezone.utc).isoformat()

    entries: list[tuple[str, float, float]] = []
    for model, info in data.items():  # type: ignore[union-attr]
        if not isinstance(info, dict):
            continue
        inp = info.get("input_cost_per_token")
        out = info.get("output_cost_per_token")
        if inp is None or out is None:
            continue
        try:
            entries.append((str(model), float(inp) * 1000, float(out) * 1000))
        except (TypeError, ValueError):
            continue

    entries.sort(key=lambda x: x[0])

    lines = [
        "# AUTO-GENERATED. Do not edit by hand.",
        "# Source: https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json",
        f"# Commit: {sha}",
        f"# Fetched: {now}",
        f"# Entries: {len(entries)}",
        "#",
        "# Regenerate: python scripts/update_model_prices.py",
        "from __future__ import annotations",
        "",
        "from .types import ModelCost",
        "",
        "DEFAULT_COST_TABLE: dict[str, ModelCost] = {",
    ]
    for model, inp, out in entries:
        lines.append(f'    {model!r}: ModelCost(input_per_1k={inp!r}, output_per_1k={out!r}),')
    lines.append("}")
    lines.append("")

    OUT_FILE.write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote {len(entries)} entries to {OUT_FILE}")


if __name__ == "__main__":
    main()
