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
  hang a turn forever — and on timeout the coroutine is cancelled so a late write
  can't still land after the tool has reported failure.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import threading
import time
from concurrent.futures import Future
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)


def _spawn_thread(target: Callable[[], Any], *, name: str, daemon: bool = True) -> threading.Thread:
    """Create the loop thread under the spawner's Hermes profile scope when possible.

    Per ``plugins/AGENTS.md`` every memory-provider background worker must go
    through ``spawn_context_thread`` so it inherits the profile's HERMES_HOME /
    secret scope. When Hermes is not importable (standalone / tests) we fall back
    to a plain daemon thread.
    """
    try:
        from agent.memory_provider import spawn_context_thread  # type: ignore
    except ImportError:
        return threading.Thread(target=target, name=name, daemon=daemon)
    return spawn_context_thread(target, name=name, daemon=daemon)


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
            self._thread = _spawn_thread(self._run, name="betterdb-memory-loop", daemon=True)
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
        """Submit *coro* and block for its result (up to *timeout* seconds).

        On timeout the underlying task is cancelled before re-raising, so a wedged
        write can't still commit after the caller has given up and reported failure.
        """
        future = self.submit(coro)
        try:
            return future.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            # Cancelling the concurrent future cancels the asyncio task that
            # run_coroutine_threadsafe scheduled, thread-safely, on the loop.
            future.cancel()
            raise

    async def _drain(self) -> None:
        """Cancel and await every other task on the loop so nothing is abandoned."""
        current = asyncio.current_task()
        pending = [t for t in asyncio.all_tasks() if t is not current and not t.done()]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    def drain(self, *, timeout: float = 5.0) -> None:
        """Cancel and await in-flight tasks WITHOUT stopping the loop.

        Lets a caller quiesce background work before tearing down the resources
        those tasks use, while the loop stays alive to run the teardown coroutines.
        A no-op if the loop isn't running or if called from the loop thread itself.
        """
        with self._lock:
            loop, thread = self._loop, self._thread
        if loop is None or thread is None or not thread.is_alive():
            return
        if threading.current_thread() is thread:
            return  # can't block the loop thread waiting on its own tasks
        try:
            future = asyncio.run_coroutine_threadsafe(self._drain(), loop)
            future.result(timeout=timeout)
        except Exception as exc:
            logger.warning("betterdb memory loop drain failed: %s", exc)

    def stop(self, *, timeout: float = 5.0) -> None:
        """Drain in-flight work, stop the loop, join the thread, then close.

        Safe to call more than once. The loop is only ``close()``d after the thread
        has actually exited — closing a still-running loop would raise — and a join
        that times out is logged rather than silently leaving the loop orphaned.

        *timeout* is a single budget shared by the drain and the join (they cannot
        stack to a multiple of it). If called from the loop thread itself, the drain
        and join are skipped — joining the current thread would deadlock — and we
        only request the loop to stop.
        """
        with self._lock:
            loop, thread = self._loop, self._thread
            self._loop = self._thread = None
        if loop is None:
            return
        if thread is not None and thread.is_alive():
            if threading.current_thread() is thread:
                loop.call_soon_threadsafe(loop.stop)
                return  # never join self; the thread unwinds run_forever on its own
            deadline = time.monotonic() + timeout
            try:
                drain = asyncio.run_coroutine_threadsafe(self._drain(), loop)
                drain.result(timeout=max(0.0, deadline - time.monotonic()))
            except Exception as exc:
                logger.warning("betterdb memory loop drain failed: %s", exc)
            loop.call_soon_threadsafe(loop.stop)
            thread.join(timeout=max(0.0, deadline - time.monotonic()))
            if thread.is_alive():
                logger.warning(
                    "betterdb memory loop thread did not exit within %.1fs; leaving loop open",
                    timeout,
                )
                return  # never close a loop whose thread is still running it
        try:
            loop.close()
        except Exception as exc:
            logger.warning("betterdb memory loop close failed: %s", exc)
