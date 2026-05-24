from __future__ import annotations

from pydantic import BaseModel


class QueryPair(BaseModel):
    prompt_a: str
    prompt_b: str
    is_semantic_match: bool
    category: str | None = None
    source: str = "unknown"


class CheckResult(BaseModel):
    hit: bool
    cached_response: str | None = None
    similarity_score: float | None = None
    latency_ms: float = 0.0


class ReplayResult(BaseModel):
    prompt_a: str
    prompt_b: str
    is_semantic_match: bool
    hit: bool
    similarity_score: float | None = None
    latency_ms: float = 0.0
    category: str | None = None


class Metrics(BaseModel):
    total: int
    true_positives: int
    false_positives: int
    true_negatives: int
    false_negatives: int
    hit_rate: float
    precision: float
    recall: float
    f1: float
    false_positive_rate: float
    p50_latency_ms: float
    p95_latency_ms: float
    p99_latency_ms: float
    mean_similarity_on_hits: float | None = None
