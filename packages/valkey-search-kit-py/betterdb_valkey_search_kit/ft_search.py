from __future__ import annotations

from typing import Any, TypedDict


class FtSearchHit(TypedDict):
    """A single FT.SEARCH hit: the matched key and its returned fields."""

    key: str
    fields: dict[str, str]


def parse_ft_search_response(raw: Any) -> list[FtSearchHit]:
    """Parse a raw FT.SEARCH response from valkey-py's execute_command().

    valkey-py returns FT.SEARCH results as a mixed bytes/str list::

        [totalCount, key1, [field1, val1, ...], key2, [...], ...]

    Returns a list of ``{"key": str, "fields": dict[str, str]}``.
    Returns ``[]`` if totalCount is 0 or the response is empty/malformed.
    Never raises: on any parse error, returns ``[]``. Binary field values
    that cannot be decoded as UTF-8 (e.g. embedding bytes) are skipped.
    """
    try:
        if not isinstance(raw, (list, tuple)) or len(raw) < 1:
            return []

        total_raw = raw[0]
        if isinstance(total_raw, bytes):
            total_raw = total_raw.decode()
        # Parse via float() so a float-formatted total (e.g. "2.0" from a RESP3
        # double) yields its integer value instead of raising and collapsing to
        # no hits — matching TS parseInt and this package's FT.INFO _to_int.
        total = int(float(total_raw))

        if total <= 0:
            return []

        results: list[FtSearchHit] = []
        i = 1
        while i < len(raw):
            key = raw[i]
            if isinstance(key, bytes):
                key = key.decode()
            elif not isinstance(key, str):
                i += 1
                continue

            if i + 1 >= len(raw):
                results.append({"key": key, "fields": {}})
                break

            field_list = raw[i + 1]
            fields: dict[str, str] = {}

            if isinstance(field_list, (list, tuple)):
                j = 0
                while j < len(field_list) - 1:
                    fname = field_list[j]
                    fval = field_list[j + 1]
                    if isinstance(fname, bytes):
                        fname = fname.decode()
                    else:
                        fname = str(fname)
                    if isinstance(fval, bytes):
                        try:
                            fval = fval.decode()
                        except (UnicodeDecodeError, AttributeError):
                            # Binary field (e.g. embedding bytes) — skip it.
                            j += 2
                            continue
                    else:
                        fval = str(fval)
                    fields[fname] = fval
                    j += 2
                i += 2
            else:
                results.append({"key": key, "fields": {}})
                i += 1
                continue

            results.append({"key": key, "fields": fields})

        return results
    except Exception:
        return []
