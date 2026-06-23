from __future__ import annotations

from typing import Any


def is_index_not_found_error(err: Any) -> bool:
    """Classify an error as a Valkey Search "index does not exist" error.

    Matches the message variants emitted across Valkey Search / RediSearch
    versions, case-insensitively. Non-exception values never match.
    """
    if not isinstance(err, BaseException):
        return False
    msg = str(err).lower()
    return (
        "unknown index name" in msg
        or "no such index" in msg
        or ("not found" in msg and "index" in msg)
    )
