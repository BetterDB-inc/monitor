from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, NotRequired, Required, TypedDict


# ─── Content blocks ───────────────────────────────────────────────────────────

class CacheControlHint(TypedDict, total=False):
    type: Required[Literal["ephemeral"]]
    ttl: Literal["5m", "1h"]


class BlockHints(TypedDict, total=False):
    anthropic_cache_control: CacheControlHint


class TextBlock(TypedDict):
    type: Literal["text"]
    text: str
    hints: NotRequired[BlockHints]


class BinaryBlock(TypedDict):
    type: Literal["binary"]
    kind: Literal["image", "audio", "document"]
    media_type: str
    ref: str
    detail: NotRequired[Literal["auto", "low", "high", "original"]]
    filename: NotRequired[str]
    hints: NotRequired[BlockHints]


class ToolCallBlock(TypedDict):
    type: Literal["tool_call"]
    id: str
    name: str
    args: Any
    hints: NotRequired[BlockHints]


class ToolResultBlock(TypedDict):
    type: Literal["tool_result"]
    toolCallId: str
    content: list[TextBlock | BinaryBlock]
    is_error: NotRequired[bool]
    hints: NotRequired[BlockHints]


class ReasoningBlock(TypedDict):
    type: Literal["reasoning"]
    text: str
    opaque_signature: NotRequired[str]
    redacted: NotRequired[bool]
    hints: NotRequired[BlockHints]


ContentBlock = TextBlock | BinaryBlock | ToolCallBlock | ToolResultBlock | ReasoningBlock


# ─── LLM cache params ─────────────────────────────────────────────────────────

class LlmCacheMessage(TypedDict, total=False):
    role: Required[Literal["system", "user", "assistant", "tool"]]
    content: Required[str | list[ContentBlock]]
    toolCallId: str
    name: str


class ToolDefinition(TypedDict):
    type: str
    function: dict[str, Any]


class LlmCacheParams(TypedDict, total=False):
    model: Required[str]
    messages: Required[list[LlmCacheMessage]]
    temperature: float
    top_p: float
    max_tokens: int
    tools: list[ToolDefinition]
    tool_choice: Any
    seed: int
    stop: list[str]
    response_format: Any
    reasoning_effort: str
    prompt_cache_key: str


# ─── Configuration ────────────────────────────────────────────────────────────

@dataclass
class ModelCost:
    input_per_1k: float
    output_per_1k: float


@dataclass
class TierDefaults:
    ttl: int | None = None


@dataclass
class TelemetryOptions:
    tracer_name: str = "@betterdb/agent-cache"
    metrics_prefix: str = "agent_cache"
    registry: Any = None  # prometheus_client.CollectorRegistry


@dataclass
class AnalyticsOptions:
    disabled: bool = False
    stats_interval_s: float = 300.0


@dataclass
class AgentCacheOptions:
    client: Any  # valkey.asyncio.Valkey | ValkeyCluster
    name: str = "betterdb_ac"
    default_ttl: int | None = None
    tier_defaults: dict[str, TierDefaults] = field(default_factory=dict)
    cost_table: dict[str, ModelCost] = field(default_factory=dict)
    use_default_cost_table: bool = True
    """Use bundled default cost table from LiteLLM. User cost_table entries override defaults. Default: True."""
    telemetry: TelemetryOptions = field(default_factory=TelemetryOptions)
    analytics: AnalyticsOptions = field(default_factory=AnalyticsOptions)


@dataclass
class ToolPolicy:
    ttl: int


# ─── Store options ────────────────────────────────────────────────────────────

@dataclass
class LlmStoreOptions:
    ttl: int | None = None
    tokens: dict[str, int] | None = None  # {"input": N, "output": N}


@dataclass
class ToolStoreOptions:
    ttl: int | None = None
    cost: float | None = None


# ─── Cache results ────────────────────────────────────────────────────────────

@dataclass
class LlmCacheResult:
    hit: bool
    tier: str = "llm"
    response: str | None = None
    content_blocks: list[ContentBlock] | None = None
    key: str | None = None


@dataclass
class ToolCacheResult:
    hit: bool
    tool_name: str = ""
    tier: str = "tool"
    response: str | None = None
    key: str | None = None


# ─── Stats ────────────────────────────────────────────────────────────────────

@dataclass
class TierStats:
    hits: int
    misses: int

    @property
    def total(self) -> int:
        return self.hits + self.misses

    @property
    def hit_rate(self) -> float:
        return self.hits / self.total if self.total > 0 else 0.0


@dataclass
class SessionStats:
    reads: int
    writes: int


@dataclass
class ToolStats:
    hits: int
    misses: int
    ttl: int | None
    cost_saved_micros: int

    @property
    def hit_rate(self) -> float:
        total = self.hits + self.misses
        return self.hits / total if total > 0 else 0.0


@dataclass
class AgentCacheStats:
    llm: TierStats
    tool: TierStats
    session: SessionStats
    cost_saved_micros: int
    per_tool: dict[str, ToolStats]


@dataclass
class ToolEffectivenessEntry:
    tool: str
    hit_rate: float
    cost_saved: float
    recommendation: Literal["increase_ttl", "optimal", "decrease_ttl_or_disable"]
