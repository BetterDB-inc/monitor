from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from .errors import ValkeyCommandError


def _cursor_done(cursor: Any) -> bool:
    """Return True when a SCAN cursor signals completion.

    In standalone mode valkey-py returns int 0.
    In cluster mode with target_nodes, some versions return a dict
    {node_repr: cursor_value} — normalise all forms safely.
    """
    if isinstance(cursor, dict):
        return all(_cursor_done(v) for v in cursor.values()) if cursor else True
    try:
        return int(cursor) == 0
    except (TypeError, ValueError):
        return not cursor


async def cluster_scan(
    client: Any,
    pattern: str,
    on_keys: Callable[[list[str], Any], Awaitable[None]],
    count: int = 100,
) -> None:
    """Scan matching keys across all master nodes (cluster) or the single node
    (standalone), calling on_keys(keys, client) with each non-empty batch.

    The same client is passed to on_keys in both modes. valkey-py's cluster
    client routes individual single-key commands automatically, so callers can
    pipeline DEL/GET per-key without hitting CROSSSLOT errors.
    """
    try:
        from valkey.asyncio.cluster import ValkeyCluster

        is_cluster = isinstance(client, ValkeyCluster)
    except ImportError:
        is_cluster = False

    if is_cluster:
        nodes = client.get_primaries()
        if not nodes:
            raise ValkeyCommandError(
                "SCAN", Exception("cluster has no master nodes visible")
            )

        for node in nodes:
            cursor: Any = 0
            while True:
                try:
                    cursor, keys = await client.scan(
                        cursor, match=pattern, count=count, target_nodes=node
                    )
                except Exception as exc:
                    raise ValkeyCommandError("SCAN", exc) from exc

                decoded = [k.decode() if isinstance(k, bytes) else k for k in keys]
                if decoded:
                    await on_keys(decoded, client)
                if _cursor_done(cursor):
                    break
    else:
        cursor = 0
        while True:
            try:
                cursor, keys = await client.scan(cursor, match=pattern, count=count)
            except Exception as exc:
                raise ValkeyCommandError("SCAN", exc) from exc

            decoded = [k.decode() if isinstance(k, bytes) else k for k in keys]
            if decoded:
                await on_keys(decoded, client)
            if _cursor_done(cursor):
                break
