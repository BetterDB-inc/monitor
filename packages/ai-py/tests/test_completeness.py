"""Guard: the facade must stay in step with the five children.

Ported in intent, not implementation, from the npm facade's
``packages/ai/src/__tests__/completeness.spec.ts``. That one reads built
``.d.ts`` files through the TypeScript compiler API because it has no other way
to see a package's exports. Python can just import the packages and compare
real objects, which is both simpler and stricter — it catches a name that
resolves to a *different* object, not only a missing one.

The collision set is computed here rather than hardcoded. ``betterdb_agent_memory``
builds its ``__all__`` at import time by appending ``betterdb_agent_cache``'s,
so any list written down in advance would be wrong.
"""

from __future__ import annotations

import importlib
import pkgutil

import betterdb_ai

CHILDREN = {
    "agent_cache": "betterdb_agent_cache",
    "semantic_cache": "betterdb_semantic_cache",
    "retrieval": "betterdb_retrieval",
    "memory": "betterdb_agent_memory",
    "search_kit": "betterdb_valkey_search_kit",
}

# Child submodules with no facade counterpart, each with a reason. A new
# submodule in a child that is not handled here fails
# ``test_every_child_submodule_has_a_facade_counterpart`` instead of silently
# going unmirrored.
SUBMODULE_EXCLUSIONS: dict[str, str] = {
    "betterdb_semantic_cache.adapters._types": "private shared typing helpers",
}


def _child_exports() -> dict[str, list[str]]:
    exports = {}
    for ns, module in CHILDREN.items():
        exports[ns] = list(getattr(importlib.import_module(module), "__all__", []))
    return exports


def _declaration_sites() -> dict[str, dict[int, list[str]]]:
    """Map each child export name to the distinct objects declared under it.

    A name exported by two packages that resolve to the *same* object is one
    declaration, not a conflict — ``betterdb_semantic_cache.utils`` re-exports
    ``escape_tag`` straight from ``betterdb_valkey_search_kit``, so both name
    the identical function and the facade can flatten it once.
    """
    sites: dict[str, dict[int, list[str]]] = {}
    for ns, module in CHILDREN.items():
        child = importlib.import_module(module)
        for name in getattr(child, "__all__", []):
            obj = getattr(child, name)
            sites.setdefault(name, {}).setdefault(id(obj), []).append(ns)
    return sites


def _ambiguous() -> set[str]:
    return {name for name, objects in _declaration_sites().items() if len(objects) > 1}


def test_exposes_all_five_namespaces() -> None:
    for ns, module in CHILDREN.items():
        assert getattr(betterdb_ai, ns) is importlib.import_module(module)
        assert ns in betterdb_ai.__all__


def test_flattens_every_unambiguous_child_export() -> None:
    ambiguous = _ambiguous()
    flat = set(betterdb_ai.__all__)
    unreachable = []

    for ns, names in _child_exports().items():
        for name in names:
            if name in ambiguous:
                continue
            if name not in flat:
                unreachable.append(f"{CHILDREN[ns]}#{name}")

    # Ambiguous names are deliberately namespace-only; they stay reachable as
    # betterdb_ai.<ns>.<name> and are covered by the namespace test above.
    assert sorted(set(unreachable)) == []


def test_never_flattens_an_ambiguous_name() -> None:
    ambiguous = _ambiguous()
    shadowed = sorted(name for name in betterdb_ai.__all__ if name in ambiguous)

    assert shadowed == []
    for name in ambiguous:
        assert not hasattr(betterdb_ai, name), (
            f"{name} is declared as a different object by more than one child; "
            "flattening it silently breaks except/isinstance for the other"
        )


def test_flat_exports_resolve_to_the_child_objects() -> None:
    sites = _declaration_sites()
    mismatched = []

    for name in betterdb_ai.__all__:
        if name in CHILDREN or name in {"AMBIGUOUS", "NAMESPACES", "__version__"}:
            continue
        owners = next(iter(sites[name].values()))
        expected = getattr(importlib.import_module(CHILDREN[owners[0]]), name)
        if getattr(betterdb_ai, name) is not expected:
            mismatched.append(name)

    assert mismatched == []


def test_ambiguous_tuple_matches_the_computed_collision_set() -> None:
    assert sorted(betterdb_ai.AMBIGUOUS) == sorted(_ambiguous())


def test_namespaces_tuple_matches_the_children() -> None:
    assert sorted(betterdb_ai.NAMESPACES) == sorted(CHILDREN)


def test_all_names_are_importable() -> None:
    missing = [name for name in betterdb_ai.__all__ if not hasattr(betterdb_ai, name)]

    assert missing == []


def _child_submodules(package: str) -> list[str]:
    parent = importlib.import_module(package)
    found = []
    for info in pkgutil.iter_modules(parent.__path__):
        if info.name.startswith("_"):
            continue
        found.append(f"{package}.{info.name}")
    return found


def test_every_child_submodule_has_a_facade_counterpart() -> None:
    sources = {
        "betterdb_agent_cache.adapters": "betterdb_ai",
        "betterdb_semantic_cache.adapters": "betterdb_ai",
        "betterdb_semantic_cache.embed": "betterdb_ai.embed",
    }
    unreachable = []

    for package, facade_package in sources.items():
        for submodule in _child_submodules(package):
            if submodule in SUBMODULE_EXCLUSIONS:
                continue
            leaf = submodule.rsplit(".", 1)[1]
            try:
                importlib.import_module(f"{facade_package}.{leaf}")
            except ModuleNotFoundError:
                unreachable.append(f"{submodule} -> {facade_package}.{leaf}")

    assert sorted(unreachable) == []


def test_exclusions_still_refer_to_real_modules() -> None:
    stale = []
    for submodule in SUBMODULE_EXCLUSIONS:
        try:
            importlib.import_module(submodule)
        except ModuleNotFoundError:
            stale.append(submodule)

    assert stale == []
