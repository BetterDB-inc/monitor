from __future__ import annotations

import asyncio
from typing import Any, Callable


class FakeClient:
    """A minimal async client double recording every execute_command call.

    ``handler`` receives the args tuple and returns the reply (or raises). It
    may be a plain function or a coroutine function.
    """

    def __init__(self, handler: Callable[[tuple[Any, ...]], Any]) -> None:
        self.calls: list[tuple[Any, ...]] = []
        self._handler = handler

    async def execute_command(self, *args: Any) -> Any:
        self.calls.append(args)
        result = self._handler(args)
        if asyncio.iscoroutine(result):
            result = await result
        return result

    def calls_for(self, command: str) -> list[tuple[Any, ...]]:
        return [c for c in self.calls if c and c[0] == command]


def search_reply(rows: list[tuple[str, dict[str, str]]]) -> list[Any]:
    """Build a raw FT.SEARCH reply: [count, key, [f, v, ...], ...]."""
    out: list[Any] = [str(len(rows))]
    for key, fields in rows:
        out.append(key)
        flat: list[str] = []
        for field, value in fields.items():
            flat.extend([field, value])
        out.append(flat)
    return out


def index_not_found_error() -> Exception:
    return Exception("Unknown index name 'docs:idx'")
