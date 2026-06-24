from __future__ import annotations

from betterdb_retrieval import QueryHit, UpsertEntry

from .types import ChunkMode, LmeRecord, LmeSession

# text-embedding-3-small accepts at most 8191 tokens per input. Cap each chunk
# well under that (~4 chars/token heuristic, with margin) so a long session is
# split into multiple chunks instead of failing the embedding call. Every part
# keeps the session's session_id, so recall (which matches on session_id) is
# unaffected.
MAX_EMBED_CHARS = 24000


def _slice_to_budget(text: str, budget: int) -> list[str]:
    """Hard-slice a string into consecutive pieces each at most ``budget`` chars."""
    return [text[i : i + budget] for i in range(0, len(text), budget)]


def _pack_turns(session: LmeSession, budget: int) -> list[str]:
    """Pack a session's turns into newline-joined chunks each within ``budget``."""
    lines: list[str] = []
    for turn in session:
        line = f"{turn['role']}: {turn['content']}"
        if len(line) <= budget:
            lines.append(line)
        else:
            # A single turn larger than the budget is hard-sliced so it still embeds.
            lines.extend(_slice_to_budget(line, budget))
    chunks: list[str] = []
    current = ""
    for line in lines:
        if len(current) > 0 and len(current) + 1 + len(line) > budget:
            chunks.append(current)
            current = line
        else:
            current = line if len(current) == 0 else f"{current}\n{line}"
    if len(current) > 0:
        chunks.append(current)
    return chunks


def chunk_record(record: LmeRecord, mode: ChunkMode) -> list[UpsertEntry]:
    """Turn a LongMemEval haystack into UpsertEntry chunks.

    - 'session' (default): one chunk per session (turns joined); sessions longer
      than the embedder's input budget are split into multiple chunks that all
      carry the same session_id.
    - 'turn': one chunk per turn.

    The id encodes the session index (+ turn/part index when split); fields carry
    the session_id tag (+ date tag when present) so recall can match evidence.
    """
    entries: list[UpsertEntry] = []
    session_ids = record["haystack_session_ids"]
    dates = record.get("haystack_dates")
    for s_idx, session in enumerate(record["haystack_sessions"]):
        session_id = session_ids[s_idx] if s_idx < len(session_ids) else f"session_{s_idx}"
        date = dates[s_idx] if dates is not None and s_idx < len(dates) else None
        base_fields: dict[str, str | int | float] = {"session_id": session_id}
        if date:
            base_fields["date"] = date

        if mode == "turn":
            for t_idx, turn in enumerate(session):
                text = f"{turn['role']}: {turn['content']}"
                # A single turn can exceed the embedder budget too; hard-slice it
                # like session mode so it still embeds instead of failing the chunk.
                parts = (
                    [text]
                    if len(text) <= MAX_EMBED_CHARS
                    else _slice_to_budget(text, MAX_EMBED_CHARS)
                )
                for p_idx, part in enumerate(parts):
                    entry_id = (
                        f"s{s_idx}_t{t_idx}" if len(parts) == 1 else f"s{s_idx}_t{t_idx}_p{p_idx}"
                    )
                    entries.append(UpsertEntry(id=entry_id, text=part, fields=dict(base_fields)))
        else:
            parts = _pack_turns(session, MAX_EMBED_CHARS)
            for p_idx, text in enumerate(parts):
                entry_id = f"s{s_idx}" if len(parts) == 1 else f"s{s_idx}_p{p_idx}"
                entries.append(UpsertEntry(id=entry_id, text=text, fields=dict(base_fields)))
    return entries


def record_is_hit(hits: list[QueryHit], answer_session_ids: list[str]) -> bool:
    """A record is a recall HIT if any retrieved chunk's session_id is evidence."""
    evidence = set(answer_session_ids)
    return any(hit.fields.get("session_id") in evidence for hit in hits)
