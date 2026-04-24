"""Hatchling build hook: replaces telemetry placeholder tokens in analytics.py
with values from environment variables (POSTHOG_API_KEY, POSTHOG_HOST).

If the env vars are not set, the placeholders remain and create_analytics
treats them as unset (falls back to noop analytics).
"""
from __future__ import annotations

import os
import tempfile

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict) -> None:
        api_key = os.environ.get("POSTHOG_API_KEY", "")
        host = os.environ.get("POSTHOG_HOST", "")

        if not api_key and not host:
            print("No telemetry env vars set — placeholders left as-is (noop fallback).")
            return

        analytics_src = os.path.join(self.root, "betterdb_semantic_cache", "analytics.py")
        with open(analytics_src) as f:
            source = f.read()

        replaced = 0
        if api_key and "__BETTERDB_POSTHOG_API_KEY__" in source:
            source = source.replace("__BETTERDB_POSTHOG_API_KEY__", api_key)
            replaced += 1
        if host and "__BETTERDB_POSTHOG_HOST__" in source:
            source = source.replace("__BETTERDB_POSTHOG_HOST__", host)
            replaced += 1

        if replaced:
            tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False)
            tmp.write(source)
            tmp.close()
            self._tmp_path = tmp.name
            build_data["force_include"][tmp.name] = "betterdb_semantic_cache/analytics.py"
            print(f"Injected {replaced} telemetry default(s) into analytics.py.")

    def finalize(self, version: str, build_data: dict, artifact_path: str) -> None:
        if hasattr(self, "_tmp_path"):
            try:
                os.unlink(self._tmp_path)
            except OSError:
                pass
