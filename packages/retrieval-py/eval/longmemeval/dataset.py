from __future__ import annotations

import json
from pathlib import Path

from .types import LmeRecord


def _fixture_path() -> Path:
    return Path(__file__).parent / "fixture.json"


def load_fixture() -> list[LmeRecord]:
    """Load the bundled LongMemEval-shaped fixture (offline, deterministic)."""
    return json.loads(_fixture_path().read_text(encoding="utf8"))


def load_dataset(data_path: str | None) -> tuple[list[LmeRecord], str]:
    """Load the dataset: the real LongMemEval json at ``data_path`` when given,
    else the bundled fixture. Returns records plus a human-readable source label.
    """
    if data_path:
        return json.loads(Path(data_path).read_text(encoding="utf8")), data_path
    return load_fixture(), "bundled fixture"
