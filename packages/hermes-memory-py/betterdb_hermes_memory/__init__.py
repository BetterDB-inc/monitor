"""betterdb — Hermes memory provider backed by betterdb-agent-memory on Valkey.

Long-term, semantic memory for Hermes agents. Completed turns are embedded and
stored in a Valkey (valkey-search) vector index; the next turn recalls the most
relevant memories and injects them as a recall block. Built on the
``betterdb-agent-memory`` SDK (``MemoryStore`` — KNN recall with a composite
similarity/recency/importance score, scoping, reinforcement and eviction).

Semantic mapping to the ``MemoryProvider`` contract:

* ``recall()``  -> ``queue_prefetch`` runs ``MemoryStore.recall`` in the
  background and caches a formatted block that ``prefetch`` returns next turn.
* ``remember()`` -> ``sync_turn`` persists each completed turn via
  ``MemoryStore.remember``; ``on_memory_write`` mirrors built-in memory-tool writes.

Config lives in ``$HERMES_HOME/config.yaml`` under ``memory.betterdb`` (non-secret
connection fields) plus scoped secrets for the password and the embeddings key.
"""

from __future__ import annotations

import json
import logging
import threading
from typing import Any, Callable, Dict, List, Optional

from agent.memory_provider import MemoryProvider, RecallStatus

from .embeddings import (
    DEFAULT_EMBEDDINGS_BASE_URL,
    DEFAULT_EMBEDDINGS_MODEL,
    EmbeddingConfig,
    EmbedFn,
    build_http_embed_fn,
)
from .runtime import LoopRuntime

logger = logging.getLogger(__name__)

__all__ = ["BetterDBMemoryProvider", "register"]

DEFAULT_STORE_NAME = "hermes"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 6379
# How many memories a recall injects, and the glyph for the recall indicator.
RECALL_K = 5
INDICATOR_GLYPH = "\U0001f9e0"  # 🧠


# --------------------------------------------------------------------------- #
# Config helpers
# --------------------------------------------------------------------------- #

def _get_secret(name: str, default: str = "") -> str:
    """Scoped secret when running inside Hermes, else the plain env var.

    Imported lazily so the package is usable (and testable) without Hermes on the
    path — ``os.environ`` is the fallback.
    """
    try:
        from agent.secret_scope import get_secret  # type: ignore

        value = get_secret(name, default)
    except Exception:
        import os

        value = os.environ.get(name, default)
    return value or default


def _load_config_block() -> Dict[str, Any]:
    """The ``memory.betterdb`` block from config.yaml (empty on any error)."""
    try:
        from hermes_cli.config import load_config_readonly  # type: ignore

        block = load_config_readonly().get("memory", {}).get("betterdb", {})
    except Exception:
        block = None
    return dict(block) if isinstance(block, dict) else {}


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


class _Config:
    """Resolved provider configuration: connection + store + embeddings."""

    def __init__(self, block: Optional[Dict[str, Any]] = None):
        block = block if block is not None else _load_config_block()
        self.url: str = _get_secret("BETTERDB_MEMORY_URL", "") or str(block.get("url", "") or "")
        self.host: str = str(block.get("host", "") or "") or DEFAULT_HOST
        self.port: int = _as_int(block.get("port"), DEFAULT_PORT)
        self.db: int = _as_int(block.get("db"), 0)
        self.username: str = str(block.get("username", "") or "")
        self.password: str = _get_secret("BETTERDB_MEMORY_PASSWORD", "")
        self.tls: bool = _as_bool(block.get("tls"), False)
        self.store_name: str = str(block.get("store_name", "") or "") or DEFAULT_STORE_NAME
        self.namespace: str = str(block.get("namespace", "") or "")
        self.embeddings = EmbeddingConfig(
            model=str(block.get("embeddings_model", "") or "") or DEFAULT_EMBEDDINGS_MODEL,
            base_url=str(block.get("embeddings_base_url", "") or "") or DEFAULT_EMBEDDINGS_BASE_URL,
            api_key=_get_secret("BETTERDB_MEMORY_EMBEDDINGS_API_KEY", ""),
        )

    def has_connection(self) -> bool:
        return bool(self.url) or bool(self.host)


# --------------------------------------------------------------------------- #
# Provider
# --------------------------------------------------------------------------- #

class BetterDBMemoryProvider(MemoryProvider):
    """Valkey-backed long-term memory via the betterdb-agent-memory SDK."""

    def __init__(
        self,
        config: Optional[Dict[str, Any]] = None,
        *,
        store: Any = None,
        runtime: Optional[LoopRuntime] = None,
        embed_fn: Optional[EmbedFn] = None,
    ):
        # Injected store/runtime/embed_fn let tests exercise the mapping without a
        # live Valkey or an embeddings endpoint.
        self._config = _Config(config)
        self._store = store
        self._runtime = runtime
        self._embed_fn = embed_fn
        self._client: Any = None
        self._session_id: str = ""
        self._agent_id: str = "hermes"
        self._agent_context: str = "primary"
        self._lock = threading.Lock()  # guards the prefetch cache below
        self._recall_block: str = ""
        self._recall_count: int = 0
        self._last_status: Optional[RecallStatus] = None
        self._pending: List[Any] = []  # in-flight futures, pruned opportunistically

    @property
    def name(self) -> str:
        return "betterdb"

    # -- availability (network-free) --------------------------------------- #

    def is_available(self) -> bool:
        """SDK importable, a connection target configured, and an embedding source
        resolvable. Pure config/dependency checks — never touches the network."""
        try:
            import betterdb_agent_memory  # noqa: F401
        except Exception:
            return False
        has_embeddings = self._embed_fn is not None or self._config.embeddings.is_configured()
        return self._config.has_connection() and has_embeddings

    def unavailable_reason(self) -> str:
        try:
            import betterdb_agent_memory  # noqa: F401
        except Exception:
            return "betterdb-agent-memory is not installed (pip install betterdb-agent-memory)."
        if not self._config.has_connection():
            return "No Valkey connection configured (set memory.betterdb.host or BETTERDB_MEMORY_URL)."
        if not (self._embed_fn is not None or self._config.embeddings.is_configured()):
            return (
                "Embeddings are not configured. betterdb-agent-memory does not ship an "
                "embedding model, so this provider needs an OpenAI-compatible endpoint. "
                "Set memory.betterdb.embeddings_api_key (OpenAI/Azure), or point "
                "memory.betterdb.embeddings_base_url at a local server (Ollama, vLLM, LM Studio)."
            )
        return ""

    # -- config wizard ----------------------------------------------------- #

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {"key": "host", "description": "Valkey host", "default": DEFAULT_HOST},
            {"key": "port", "description": "Valkey port", "type": "integer", "default": DEFAULT_PORT},
            {"key": "db", "description": "Valkey logical database", "type": "integer", "default": 0},
            {"key": "username", "description": "Valkey ACL username (optional)", "default": ""},
            {"key": "password", "description": "Valkey password", "secret": True,
             "env_var": "BETTERDB_MEMORY_PASSWORD", "required": False},
            {"key": "tls", "description": "Connect over TLS", "type": "boolean", "default": "false",
             "choices": ["true", "false"]},
            {"key": "url", "description": "Full valkey:// URL (overrides host/port)", "secret": True,
             "env_var": "BETTERDB_MEMORY_URL", "required": False},
            {"key": "store_name", "description": "Memory store / index name prefix",
             "default": DEFAULT_STORE_NAME},
            {"key": "namespace", "description": "Optional memory namespace (scopes recall/writes)",
             "default": ""},
            {"key": "embeddings_model", "description": "Embeddings model",
             "default": DEFAULT_EMBEDDINGS_MODEL},
            {"key": "embeddings_base_url",
             "description": "OpenAI-compatible embeddings endpoint. Defaults to OpenAI; point at "
                            "Ollama, vLLM or LM Studio to run locally without a key.",
             "default": DEFAULT_EMBEDDINGS_BASE_URL},
            {"key": "embeddings_api_key",
             "description": "API key for the embeddings endpoint (OpenAI/Azure/gateway). "
                            "Local servers like Ollama or vLLM usually need none.",
             "secret": True, "env_var": "BETTERDB_MEMORY_EMBEDDINGS_API_KEY", "required": False,
             "url": "https://platform.openai.com/api-keys"},
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        """Persist non-secret fields to config.yaml under ``memory.betterdb``.

        Secrets (``password``, ``url``, ``embeddings_api_key``) carry ``env_var`` in
        the schema, so Hermes routes them to the scoped secret store; they must not
        be written here.
        """
        from hermes_cli.config import save_config  # type: ignore

        secret_keys = {"password", "url", "embeddings_api_key"}
        persisted = {k: v for k, v in values.items() if k not in secret_keys}
        save_config({"memory": {"betterdb": persisted}}, merge_existing=True)

    # -- lifecycle --------------------------------------------------------- #

    def initialize(self, session_id: str, **kwargs) -> None:
        from betterdb_agent_memory import MemoryStore  # heavy; import on activation

        self._session_id = session_id
        self._agent_id = kwargs.get("agent_id") or kwargs.get("agent_identity") or "hermes"
        self._agent_context = kwargs.get("agent_context", "primary") or "primary"

        if self._runtime is None:
            self._runtime = LoopRuntime()
        self._runtime.start()

        if self._embed_fn is None:
            self._embed_fn = build_http_embed_fn(self._config.embeddings)

        if self._store is None:
            self._client = self._build_client()
            self._store = MemoryStore(
                client=self._client,
                name=self._config.store_name,
                embed_fn=self._embed_fn,
                discovery=True,  # let BetterDB Monitor enumerate this tier
            )

        # Create the vector index up front, off the calling thread. The store is
        # unusable until the index exists, but a turn should never block on it.
        self._submit(self._store.ensure_index(), label="ensure_index")

    def _build_client(self) -> Any:
        """Construct a ``valkey.asyncio`` client from the resolved config."""
        import valkey.asyncio as valkey  # type: ignore

        if self._config.url:
            return valkey.Valkey.from_url(self._config.url)
        kwargs: Dict[str, Any] = {
            "host": self._config.host,
            "port": self._config.port,
            "db": self._config.db,
        }
        if self._config.username:
            kwargs["username"] = self._config.username
        if self._config.password:
            kwargs["password"] = self._config.password
        if self._config.tls:
            kwargs["ssl"] = True
        return valkey.Valkey(**kwargs)

    # -- recall  (recall -> prefetch, non-blocking) ------------------------ #

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Run recall in the background and cache a formatted block for next turn.

        The actual Valkey round-trip happens on the runtime's event loop, so this
        returns immediately; ``prefetch`` only ever reads the cache.
        """
        if not self._store or not self._runtime or not query.strip():
            return
        future = self._submit(
            self._store.recall(query, k=RECALL_K, agent_id=self._agent_id, **self._scope_kwargs()),
            label="recall",
        )
        if future is None:
            return

        def _on_done(fut: Any) -> None:
            try:
                hits = fut.result()
            except Exception as exc:  # recall is best-effort; a failure injects nothing
                logger.debug("betterdb recall failed: %s", exc)
                return
            block, count = self._format_recall(hits)
            with self._lock:
                self._recall_block = block
                self._recall_count = count

        future.add_done_callback(_on_done)

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Return (and clear) the cached recall block. Fast — no network here."""
        with self._lock:
            block, count = self._recall_block, self._recall_count
            self._recall_block, self._recall_count = "", 0
            self._last_status = (
                RecallStatus(provider_label="BetterDB", count=count, glyph=INDICATOR_GLYPH)
                if block
                else None
            )
        return block

    def recall_status(self) -> Optional[RecallStatus]:
        return self._last_status

    @staticmethod
    def _format_recall(hits: List[Any]) -> tuple[str, int]:
        lines = []
        for hit in hits or []:
            content = getattr(getattr(hit, "item", None), "content", "") or ""
            if content:
                lines.append(f"- {content}")
        if not lines:
            return "", 0
        return "## BetterDB Memory\n" + "\n".join(lines), len(lines)

    # -- remember  (remember -> sync_turn) --------------------------------- #

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: Optional[List[Dict[str, Any]]] = None,
        turn_author: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Persist a completed turn in the background. Returns immediately."""
        if not self._should_write() or not user_content.strip():
            return
        content = f"User: {user_content.strip()}"
        if assistant_content and assistant_content.strip():
            content += f"\nAssistant: {assistant_content.strip()}"
        self._remember(content, source="turn", session_id=session_id or self._session_id)

    def on_memory_write(
        self, action: str, target: str, content: str, metadata: Optional[Dict[str, Any]] = None
    ) -> None:
        """Mirror a built-in memory-tool write into the long-term store."""
        if action != "add" or not self._should_write() or not content.strip():
            return
        self._remember(
            content.strip(),
            source="user" if target == "user" else "memory",
            importance=0.8 if target == "user" else 0.6,
            session_id=self._session_id,
        )

    def _remember(
        self,
        content: str,
        *,
        source: str,
        session_id: str,
        importance: Optional[float] = None,
    ) -> None:
        if not self._store or not self._runtime:
            return
        self._submit(
            self._store.remember(
                content,
                source=source,
                importance=importance,
                agent_id=self._agent_id,
                thread_id=session_id or None,
                **self._scope_kwargs(),
            ),
            label="remember",
        )

    # -- tools ------------------------------------------------------------- #

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": "betterdb_remember",
                "description": "Store a durable fact, preference or decision in long-term memory.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string", "description": "The fact to remember."},
                        "importance": {"type": "number", "description": "Importance 0-1 (default 0.7)."},
                        "tags": {"type": "array", "items": {"type": "string"},
                                 "description": "Optional tags for scoping recall."},
                    },
                    "required": ["content"],
                },
            },
            {
                "name": "betterdb_recall",
                "description": "Semantic search of long-term memory. Returns ranked memories.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "What to recall."},
                        "k": {"type": "integer", "description": "Max results (default 8)."},
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "betterdb_forget",
                "description": "Delete a specific memory by its id.",
                "parameters": {
                    "type": "object",
                    "properties": {"id": {"type": "string", "description": "Memory id to delete."}},
                    "required": ["id"],
                },
            },
        ]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        from tools.registry import tool_error  # type: ignore

        if not self._store or not self._runtime:
            return tool_error("BetterDB memory is not initialized")
        try:
            if tool_name == "betterdb_remember":
                mem_id = self._runtime.run(
                    self._store.remember(
                        args["content"],
                        importance=float(args["importance"]) if "importance" in args else 0.7,
                        tags=args.get("tags"),
                        source="tool",
                        agent_id=self._agent_id,
                        thread_id=self._session_id or None,
                        **self._scope_kwargs(),
                    ),
                    timeout=10.0,
                )
                return json.dumps({"id": mem_id, "status": "remembered"})
            if tool_name == "betterdb_recall":
                hits = self._runtime.run(
                    self._store.recall(
                        args["query"],
                        k=_as_int(args.get("k"), 8),
                        agent_id=self._agent_id,
                        **self._scope_kwargs(),
                    ),
                    timeout=10.0,
                )
                results = [
                    {"id": h.item.id, "content": h.item.content, "score": h.score}
                    for h in hits
                ]
                return json.dumps({"results": results, "count": len(results)})
            if tool_name == "betterdb_forget":
                removed = self._runtime.run(self._store.forget(args["id"]), timeout=10.0)
                return json.dumps({"removed": bool(removed)})
            return tool_error(f"Unknown tool: {tool_name}")
        except KeyError as exc:
            return tool_error(f"Missing required argument: {exc}")
        except Exception as exc:
            return tool_error(str(exc))

    # -- shutdown ---------------------------------------------------------- #

    def shutdown(self) -> None:
        store, runtime, self._store, self._runtime = self._store, self._runtime, None, None
        if store is not None and runtime is not None:
            try:
                runtime.run(store.close(), timeout=5.0)
            except Exception as exc:
                logger.debug("betterdb store close failed: %s", exc)
        if runtime is not None:
            runtime.stop()
        self._client = None

    # -- internals --------------------------------------------------------- #

    def _should_write(self) -> bool:
        # Only the primary agent context persists; subagent/cron/flush runs read.
        return self._agent_context == "primary"

    def _scope_kwargs(self) -> Dict[str, Any]:
        return {"namespace": self._config.namespace} if self._config.namespace else {}

    def _submit(self, coro: Any, *, label: str) -> Any:
        """Fire-and-forget a coroutine onto the runtime loop; prune finished futures."""
        if not self._runtime:
            return None
        try:
            future = self._runtime.submit(coro)
        except Exception as exc:
            logger.debug("betterdb %s submit failed: %s", label, exc)
            return None
        self._pending = [f for f in self._pending if not f.done()]
        self._pending.append(future)
        return future


def register(ctx) -> None:
    """Module-level registration hook (plugin dir + entry point both call this)."""
    ctx.register_memory_provider(BetterDBMemoryProvider())
