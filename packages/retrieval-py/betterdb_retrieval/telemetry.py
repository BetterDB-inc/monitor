from __future__ import annotations

from typing import Literal, Protocol, runtime_checkable

RetrievalOperation = Literal["upsert", "query"]


@runtime_checkable
class RetrievalMetrics(Protocol):
    def observe_operation(self, operation: RetrievalOperation, seconds: float) -> None: ...

    def record_query_results(self, count: int) -> None: ...

    def record_embedding_call(self) -> None: ...


@runtime_checkable
class RetrievalSpan(Protocol):
    def end(self) -> None: ...


@runtime_checkable
class RetrievalTracer(Protocol):
    def start_span(self, name: str) -> RetrievalSpan: ...
