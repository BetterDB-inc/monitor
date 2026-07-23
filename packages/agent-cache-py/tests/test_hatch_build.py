from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from typing import Any

import pytest

API_KEY_PLACEHOLDER = "__BETTERDB_POSTHOG_API_KEY__"
HOST_PLACEHOLDER = "__BETTERDB_POSTHOG_HOST__"
TELEMETRY_VARS = ("POSTHOG_API_KEY", "POSTHOG_HOST", "REQUIRE_TELEMETRY_KEY")

PACKAGES_DIR = Path(__file__).resolve().parents[2]

# Every SDK ships its own copy of this hook, differing only in the module it
# rewrites. The guard is what stands between a missed key and another
# telemetry-blind publish, so all four are exercised here rather than trusting
# the copies to stay in step.
HOOKS = {
    "agent-cache-py": "betterdb_agent_cache",
    "agent-memory-py": "betterdb_agent_memory",
    "retrieval-py": "betterdb_retrieval",
    "semantic-cache-py": "betterdb_semantic_cache",
}


def _load_hook_class(package: str) -> Any:
    """Import a package's hatch_build.py by path — it is outside the importable package."""
    spec = importlib.util.spec_from_file_location(
        f"hatch_build_under_test_{package.replace('-', '_')}",
        PACKAGES_DIR / package / "hatch_build.py",
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.CustomBuildHook


def _make_hook(package: str, root: Path) -> Any:
    """
    Build the real hook against a temp project root. `root` is a property on
    hatchling's BuildHookInterface, so it is overridden rather than assigned;
    the rest of hatchling's constructor plumbing is irrelevant to this logic.
    """
    hook_class = _load_hook_class(package)

    class TestableHook(hook_class):  # type: ignore[valid-type, misc]
        def __init__(self, project_root: Path) -> None:
            self._project_root = str(project_root)

        @property
        def root(self) -> str:
            return self._project_root

    return TestableHook(root)


def _make_root(tmp_path: Path, package: str, source: str | None = None) -> Path:
    root = tmp_path / package
    module_dir = root / HOOKS[package]
    module_dir.mkdir(parents=True)
    (module_dir / "analytics.py").write_text(
        source
        if source is not None
        else (
            f'_BAKED_POSTHOG_API_KEY = "{API_KEY_PLACEHOLDER}"\n'
            f'_BAKED_POSTHOG_HOST = "{HOST_PLACEHOLDER}"\n'
        )
    )
    return root


def _build_data() -> dict[str, Any]:
    return {"force_include": {}}


@pytest.fixture(autouse=True)
def _clean_telemetry_env(monkeypatch: pytest.MonkeyPatch) -> None:
    # The release workflow sets these for real; strip them so an inherited value
    # cannot mask a failure these tests exist to catch.
    for var in TELEMETRY_VARS:
        monkeypatch.delenv(var, raising=False)


@pytest.mark.parametrize("package", HOOKS)
def test_raises_when_key_required_but_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, package: str
) -> None:
    monkeypatch.setenv("REQUIRE_TELEMETRY_KEY", "1")
    root = _make_root(tmp_path, package)

    with pytest.raises(RuntimeError, match="POSTHOG_API_KEY is not"):
        _make_hook(package, root).initialize("0.1.0", _build_data())


@pytest.mark.parametrize("package", HOOKS)
def test_raises_when_placeholder_is_absent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, package: str
) -> None:
    # A key is supplied but the token was renamed in source, so nothing is
    # substituted. Absence of the placeholder must not read as "injected".
    root = _make_root(tmp_path, package, source='_BAKED_POSTHOG_API_KEY = "__RENAMED_TOKEN__"\n')
    monkeypatch.setenv("REQUIRE_TELEMETRY_KEY", "1")
    monkeypatch.setenv("POSTHOG_API_KEY", "phc_real_key")

    with pytest.raises(RuntimeError, match="was not found in analytics.py"):
        _make_hook(package, root).initialize("0.1.0", _build_data())


@pytest.mark.parametrize("package", HOOKS)
def test_injects_key_and_host_when_supplied(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, package: str
) -> None:
    monkeypatch.setenv("REQUIRE_TELEMETRY_KEY", "1")
    monkeypatch.setenv("POSTHOG_API_KEY", "phc_real_key")
    monkeypatch.setenv("POSTHOG_HOST", "https://eu.posthog.com")
    root = _make_root(tmp_path, package)
    build_data = _build_data()
    hook = _make_hook(package, root)

    hook.initialize("0.1.0", build_data)

    assert len(build_data["force_include"]) == 1
    injected_path, target = next(iter(build_data["force_include"].items()))
    assert target == f"{HOOKS[package]}/analytics.py"
    injected = Path(injected_path).read_text()
    assert "phc_real_key" in injected
    assert "https://eu.posthog.com" in injected
    assert API_KEY_PLACEHOLDER not in injected

    hook.finalize("0.1.0", build_data, "artifact.whl")
    assert not os.path.exists(injected_path)


@pytest.mark.parametrize("package", HOOKS)
def test_leaves_placeholders_for_a_local_build(tmp_path: Path, package: str) -> None:
    root = _make_root(tmp_path, package)
    build_data = _build_data()

    _make_hook(package, root).initialize("0.1.0", build_data)

    assert build_data["force_include"] == {}
    assert API_KEY_PLACEHOLDER in (root / HOOKS[package] / "analytics.py").read_text()


@pytest.mark.parametrize("package", HOOKS)
def test_accepts_already_injected_source(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, package: str
) -> None:
    # `python -m build` builds the wheel from a freshly built sdist whose
    # analytics.py already had the key injected during the sdist pass. The
    # placeholder is legitimately gone and the real key is present — this must
    # not be mistaken for a renamed token, and there is nothing left to inject.
    monkeypatch.setenv("REQUIRE_TELEMETRY_KEY", "1")
    monkeypatch.setenv("POSTHOG_API_KEY", "phc_real_key")
    root = _make_root(tmp_path, package, source='_BAKED_POSTHOG_API_KEY = "phc_real_key"\n')
    build_data = _build_data()

    _make_hook(package, root).initialize("0.1.0", build_data)

    assert build_data["force_include"] == {}
