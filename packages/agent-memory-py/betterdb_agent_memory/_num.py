from __future__ import annotations

import math
import re

_FLOAT_RE = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?")
_INT_RE = re.compile(r"^[+-]?\d+")


def _coerce_str(value: object) -> str:
    """Coerce a valkey reply value to text the way JS ``String()`` would.

    valkey-py can hand back ``bytes`` for raw replies, so decode those instead of
    stringifying them (``str(b'1')`` is ``"b'1'"``, which would parse as NaN).
    """
    if isinstance(value, bytes):
        return value.decode()
    return str(value)


def js_number(value: object) -> float:
    """Mimic JavaScript ``Number(value)`` for the string inputs we see.

    Empty/whitespace-only strings become ``0`` (as in JS); unparseable strings
    become ``NaN``. ``None`` becomes ``NaN``.
    """
    if value is None:
        return math.nan
    text = _coerce_str(value).strip()
    if text == "":
        return 0.0
    try:
        return float(text)
    except ValueError:
        return math.nan


def parse_float(value: object) -> float:
    """Mimic JavaScript ``parseFloat``: parse the leading numeric portion, else NaN."""
    if value is None:
        return math.nan
    match = _FLOAT_RE.match(_coerce_str(value).strip())
    return float(match.group()) if match else math.nan


def parse_int(value: object) -> float:
    """Mimic JavaScript ``parseInt(value, 10)``: parse the leading integer, else NaN."""
    if value is None:
        return math.nan
    match = _INT_RE.match(_coerce_str(value).strip())
    return int(match.group()) if match else math.nan
