from __future__ import annotations

import re

_TAG_ESCAPE_RE = re.compile(r'([,.<>{}\[\]"\'!@#$%^&*()\-+=~|/\\:; ])')


def escape_tag(value: str) -> str:
    """Escape a string for safe use as a Valkey Search TAG filter value.

    Spaces are escaped because Valkey Search treats unescaped spaces in TAG
    values as term separators (OR semantics), which would broaden the filter
    unintentionally.
    """
    return _TAG_ESCAPE_RE.sub(r"\\\1", value)
