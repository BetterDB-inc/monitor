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

        if os.environ.get("REQUIRE_TELEMETRY_KEY") and not api_key:
            raise RuntimeError(
                "REQUIRE_TELEMETRY_KEY is set but POSTHOG_API_KEY is not — "
                "refusing to build a telemetry-blind wheel."
            )

        if not api_key and not host:
            print("No telemetry env vars set — placeholders left as-is (noop fallback).")
            return

        analytics_src = os.path.join(self.root, "betterdb_retrieval", "analytics.py")
        with open(analytics_src) as f:
            original_source = f.read()

        # An absent placeholder is not proof of success: the token may have been
        # renamed in the source, in which case nothing is injected and every
        # check below passes while the wheel ships telemetry-blind. But `python -m
        # build` builds the wheel from a freshly built sdist whose analytics.py was
        # already injected during the sdist pass — there the placeholder is
        # legitimately gone and the real key is present, which is success, not a
        # rename. Only fail when neither the placeholder nor the injected key is
        # there.
        if (
            os.environ.get("REQUIRE_TELEMETRY_KEY")
            and "__BETTERDB_POSTHOG_API_KEY__" not in original_source
            and api_key not in original_source
        ):
            raise RuntimeError(
                "REQUIRE_TELEMETRY_KEY is set but __BETTERDB_POSTHOG_API_KEY__ was not "
                "found in analytics.py — the token was renamed. Refusing to build a "
                "wheel whose telemetry key cannot be verified."
            )

        source = original_source
        replaced = 0
        if api_key and "__BETTERDB_POSTHOG_API_KEY__" in source:
            source = source.replace("__BETTERDB_POSTHOG_API_KEY__", api_key)
            replaced += 1
        if host and "__BETTERDB_POSTHOG_HOST__" in source:
            source = source.replace("__BETTERDB_POSTHOG_HOST__", host)
            replaced += 1

        if os.environ.get("REQUIRE_TELEMETRY_KEY") and "__BETTERDB_POSTHOG_API_KEY__" in source:
            raise RuntimeError(
                "REQUIRE_TELEMETRY_KEY is set but __BETTERDB_POSTHOG_API_KEY__ was "
                "not injected — refusing to build a telemetry-blind wheel."
            )

        if replaced:
            tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False)
            tmp.write(source)
            tmp.close()
            self._tmp_path = tmp.name
            build_data["force_include"][tmp.name] = "betterdb_retrieval/analytics.py"
            print(f"Injected {replaced} telemetry default(s) into analytics.py.")

    def finalize(self, version: str, build_data: dict, artifact_path: str) -> None:
        if hasattr(self, "_tmp_path"):
            os.unlink(self._tmp_path)
