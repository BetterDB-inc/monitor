"""Test harness: stub the Hermes modules the provider imports at module load.

The provider targets Hermes (``agent.memory_provider``, ``tools.registry``), which
is not a pip dependency of this package. These minimal stubs let the unit tests
exercise the provider in isolation — no Hermes checkout and no live Valkey.
"""

from __future__ import annotations

import contextvars
import sys
import threading
import types
from dataclasses import dataclass


def _install_hermes_stubs() -> None:
    if "agent.memory_provider" in sys.modules:
        return

    agent_pkg = types.ModuleType("agent")
    agent_pkg.__path__ = []  # mark as package
    mp = types.ModuleType("agent.memory_provider")

    @dataclass(frozen=True)
    class RecallStatus:
        provider_label: str
        count: int
        glyph: str = "\U0001f9e0"

    class MemoryProvider:
        """Minimal stand-in: the real base is an ABC with optional hook defaults.
        The provider under test overrides everything it uses, so a plain base is enough."""

    def spawn_context_thread(target, *, name, daemon=True, args=(), kwargs=None):
        """Mirror the real helper: run *target* under a copy of the caller's context."""
        ctx = contextvars.copy_context()
        return threading.Thread(
            target=lambda: ctx.run(target, *(args or ()), **(kwargs or {})),
            name=name, daemon=daemon,
        )

    mp.RecallStatus = RecallStatus
    mp.MemoryProvider = MemoryProvider
    mp.spawn_context_thread = spawn_context_thread
    agent_pkg.memory_provider = mp

    tools_pkg = types.ModuleType("tools")
    tools_pkg.__path__ = []
    registry = types.ModuleType("tools.registry")
    registry.tool_error = lambda msg: __import__("json").dumps({"error": str(msg)})
    tools_pkg.registry = registry

    sys.modules["agent"] = agent_pkg
    sys.modules["agent.memory_provider"] = mp
    sys.modules["tools"] = tools_pkg
    sys.modules["tools.registry"] = registry


_install_hermes_stubs()
