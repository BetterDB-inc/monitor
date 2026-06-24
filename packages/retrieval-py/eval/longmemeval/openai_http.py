from __future__ import annotations

import asyncio
import json
import os
import socket
import urllib.error
import urllib.request
from typing import Any

# Per-request wall-clock timeout (seconds) and retry budget for OpenAI calls.
# The TS harness used a bare ``fetch`` with no timeout, so a single hung reasoning
# request could stall the whole eval indefinitely; cap each request and retry a
# few times on timeout / rate-limit / 5xx so one slow call doesn't kill the run.
HTTP_TIMEOUT_S = float(os.environ.get("LONGMEMEVAL_HTTP_TIMEOUT", "60"))
MAX_ATTEMPTS = max(1, int(os.environ.get("LONGMEMEVAL_HTTP_RETRIES", "3")))
_RETRYABLE_STATUS = {408, 409, 425, 429, 500, 502, 503, 504}


class _RetryableHTTPError(Exception):
    """Transient OpenAI failure (timeout / rate-limit / 5xx) worth retrying."""


def _post_blocking(url: str, api_key: str, payload: dict[str, Any], label: str) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
            return json.loads(resp.read().decode("utf8"))
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf8", "replace")[:300]
        message = f"OpenAI {label} failed ({err.code}): {body}"
        if err.code in _RETRYABLE_STATUS:
            raise _RetryableHTTPError(message) from err
        raise RuntimeError(message) from err
    except (TimeoutError, socket.timeout, urllib.error.URLError) as err:
        raise _RetryableHTTPError(f"OpenAI {label} request error: {err}") from err


async def post_json(url: str, api_key: str, payload: dict[str, Any], label: str) -> dict[str, Any]:
    """POST JSON to an OpenAI endpoint off the event loop, mirroring TS ``fetch``,
    with a per-request timeout and bounded retries on transient failures.
    """
    last: _RetryableHTTPError | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return await asyncio.to_thread(_post_blocking, url, api_key, payload, label)
        except _RetryableHTTPError as err:
            last = err
            if attempt < MAX_ATTEMPTS:
                # Linear backoff capped at 10s; enough to ride out a slow response
                # or a transient rate limit without dragging the run out.
                await asyncio.sleep(min(2 * attempt, 10))
    raise RuntimeError(f"{last} (after {MAX_ATTEMPTS} attempts)") from last
