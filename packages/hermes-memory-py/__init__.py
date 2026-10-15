"""Hermes directory-plugin entry.

When Hermes installs this package from the plugin catalog it clones the repo and
loads the plugin directory by path, so it looks for ``register`` at the plugin
root. The provider lives in the ``betterdb_hermes_memory`` package (also the pip
entry point); re-export ``register`` here so both the directory-load and the
``hermes_agent.memory_providers`` entry-point paths resolve to the same hook.
"""

from betterdb_hermes_memory import register  # noqa: F401

__all__ = ["register"]
