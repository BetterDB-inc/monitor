"""Async-to-sync bridge for driving the betterdb-agent-memory SDK.

The SDK (``MemoryStore`` / ``AgentMemory``) is fully asynchronous — every
``remember`` / ``recall`` / ``ensure_index`` call is a coroutine and the Valkey
client it talks to is ``valkey.asyncio``. The Hermes ``MemoryProvider`` contract,
on the other hand, is synchronous. Rather than spin up a fresh event loop per
call (which would churn the connection pool), we run ONE long-lived event loop on
a dedicated daemon thread and submit coroutines to it with
``run_coroutine_threadsafe``.

This keeps two promises the provider cares about:

* Background work (prefetch recall, turn writes) submits a coroutine and never
  touches the calling thread's loop.
* A blocking call can wait with a timeout, so a wedged network round-trip can't
  hang a turn forever.
"""

from __future__ import annotations

import asyncio
import threading
from concurrent.futures import Future
from typing import Any, Awaitable, Optional


class LoopRuntime:
    """Owns a background asyncio event loop and submits coroutines onto it."""

    def __init__(self) -> None:
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

    def start(self) -> None:
        """Start the loop thread. Idempotent."""
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._loop = asyncio.new_event_loop()
            self._thread = threading.Thread(
                target=self._run, name="betterdb-memory-loop", daemon=True
            )
            self._thread.start()

    def _run(self) -> None:
        assert self._loop is not None
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def submit(self, coro: Awaitable[Any]) -> "Future[Any]":
        """Schedule *coro* on the loop and return a concurrent.futures.Future.

        Fire-and-forget callers can ignore the future; it still surfaces an
        exception if they later call ``.result()``.
        """
        if self._loop is None:
            raise RuntimeError("LoopRuntime.start() must be called before submit()")
        return asyncio.run_coroutine_threadsafe(coro, self._loop)

    def run(self, coro: Awaitable[Any], *, timeout: Optional[float] = None) -> Any:
        """Submit *coro* and block for its result (up to *timeout* seconds)."""
        return self.submit(coro).result(timeout=timeout)

    def stop(self, *, timeout: float = 5.0) -> None:
        """Stop the loop and join the thread. Safe to call more than once."""
        with self._lock:
            loop, thread = self._loop, self._thread
            self._loop = self._thread = None
        if loop is None:
            return
        loop.call_soon_threadsafe(loop.stop)
        if thread is not None:
            thread.join(timeout=timeout)
        # Closing from the owner thread is fine once run_forever() has returned.
        try:
            loop.close()
        except Exception:
            pass
