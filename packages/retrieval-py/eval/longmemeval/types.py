from __future__ import annotations

from typing import Literal, NotRequired, Protocol, TypedDict

from betterdb_retrieval import RetrieverClient


class LmeTurn(TypedDict):
    """A single turn in a LongMemEval session."""

    role: str  # 'user' | 'assistant'
    content: str
    has_answer: NotRequired[bool]


# One session is an ordered list of turns.
LmeSession = list[LmeTurn]


class LmeRecord(TypedDict):
    """LongMemEval record shape (real dataset + bundled fixture).

    See https://github.com/xiaowu0162/LongMemEval
    """

    question_id: str
    question_type: str
    question: str
    answer: str
    question_date: NotRequired[str]
    haystack_session_ids: list[str]
    haystack_dates: NotRequired[list[str]]
    haystack_sessions: list[LmeSession]
    answer_session_ids: list[str]


ChunkMode = Literal["session", "turn"]


class Embedder(Protocol):
    """EMBEDDER seam.

    ``dims`` MUST equal the length the ``embed`` coroutine returns so the
    schema's ``vector.dims`` matches (OpenAI text-embedding-3-small = 1536).
    """

    name: str
    dims: int

    async def embed(self, text: str) -> list[float]: ...

    async def flush(self) -> None:
        """Persist any cache to disk (no-op for the mock)."""
        ...


class Store(Protocol):
    """STORE seam.

    ``client`` is handed to the Retriever. ``is_real`` drives async
    index-settling polling; mock stores are synchronous and exact.
    """

    name: str
    is_real: bool
    client: RetrieverClient

    async def close(self) -> None: ...


class Reader(Protocol):
    """READER seam (Tier 2): generate an answer from retrieved context."""

    name: str

    async def answer(self, question: str, contexts: list[str]) -> str: ...


class Judge(Protocol):
    """JUDGE seam (Tier 2): grade a generated answer against gold."""

    name: str

    async def grade(self, question: str, gold: str, predicted: str) -> bool: ...
