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

import concurrent.futures
import json
import logging
import threading
from typing import Any, Dict, List, Optional

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

    The ``agent.secret_scope`` import is lazy so the package stays usable (and
    testable) without Hermes on the path. Only ``ImportError`` falls back to
    ``os.environ`` — that is the standalone / test case. A failure raised BY the
    scoped lookup (e.g. an unresolved profile secret inside Hermes) propagates so
    we fail closed instead of silently reading an ambient env var from the wrong
    profile.
    """
    try:
        from agent.secret_scope import get_secret  # type: ignore
    except ImportError:
        import os

        return os.environ.get(name, default) or default
    return get_secret(name, default) or default


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


def _as_float(value: Any, default: float) -> float:
    """Parse *value* to float, falling back to *default* on None/missing/non-numeric."""
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def _tls_url(url: str) -> str:
    """Return *url* with its scheme upgraded to the TLS variant.

    valkey-py's ``from_url`` rejects an ``ssl=`` keyword, so TLS for a URL
    connection is expressed through the scheme: ``valkeys://`` / ``rediss://``
    select the SSL connection class. A plaintext scheme is upgraded in place; an
    already-secure (or unrecognized) scheme is returned untouched.
    """
    scheme, sep, rest = url.partition("://")
    if not sep:
        return url
    upgrade = {"valkey": "valkeys", "redis": "rediss"}
    return f"{upgrade.get(scheme.lower(), scheme)}{sep}{rest}"


class _Config:
    """Resolved provider configuration: connection + store + embeddings.

    A provider instance is bound to a single Hermes profile/session. Config and
    secrets are resolved live at each availability check and at initialize() for
    that profile — rather than cached at construction — so the values always
    reflect that profile's current scope.
    """

    def __init__(self, block: Optional[Dict[str, Any]] = None):
        block = block if block is not None else _load_config_block()
        raw_host = str(block.get("host", "") or "")
        raw_port = block.get("port")
        raw_db = block.get("db")
        self.url: str = _get_secret("BETTERDB_MEMORY_URL", "") or str(block.get("url", "") or "")
        self.host: str = raw_host or DEFAULT_HOST
        self.port: int = _as_int(raw_port, DEFAULT_PORT)
        self.db: int = _as_int(raw_db, 0)
        self.username: str = str(block.get("username", "") or "")
        self.password: str = _get_secret("BETTERDB_MEMORY_PASSWORD", "")
        self.tls: bool = _as_bool(block.get("tls"), False)
        self.store_name: str = str(block.get("store_name", "") or "") or DEFAULT_STORE_NAME
        self.namespace: str = str(block.get("namespace", "") or "")
        # Register a discovery marker so BetterDB Monitor can enumerate this tier.
        # Off by default (opt-in); set true to let Monitor see this tier.
        self.discovery: bool = _as_bool(block.get("discovery"), False)
        # Whether the user *explicitly* pointed us at a connection, as opposed to
        # falling through to the silent 127.0.0.1 default. Availability must reflect
        # real configuration (see has_connection); the client still targets
        # DEFAULT_HOST when nothing is set.
        self._explicit_host: bool = bool(raw_host)
        self._explicit_port: bool = raw_port is not None
        self._explicit_db: bool = raw_db is not None
        self.embeddings = EmbeddingConfig(
            model=str(block.get("embeddings_model", "") or "") or DEFAULT_EMBEDDINGS_MODEL,
            base_url=str(block.get("embeddings_base_url", "") or "") or DEFAULT_EMBEDDINGS_BASE_URL,
            api_key=_get_secret("BETTERDB_MEMORY_EMBEDDINGS_API_KEY", ""),
        )

    def has_connection(self) -> bool:
        """True only when a connection was actually configured — a ``url`` or an
        explicit host/port. The implicit 127.0.0.1 default does NOT count, so the
        "no Valkey configured" availability branch can render for a bare install."""
        return bool(self.url) or self._explicit_host or self._explicit_port


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
        #
        # Keep only the raw override dict; _Config is resolved live (see its
        # docstring for why) rather than frozen here.
        self._config_input = config
        self._config: Optional[_Config] = None  # set in initialize() for operational use
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
        self._recall_session: str = ""  # the session the cached block was recalled for
        self._last_status: Optional[RecallStatus] = None

    @property
    def name(self) -> str:
        return "betterdb"

    # -- availability (network-free) --------------------------------------- #

    def is_available(self) -> bool:
        """SDK importable, a connection target configured, and an embedding source
        resolvable. Pure config/dependency checks — never touches the network.
        Available exactly when there is no reason to be unavailable."""
        return not self.unavailable_reason()

    def unavailable_reason(self) -> str:
        """Empty string when usable, else a human-readable reason.

        Resolves a fresh config so the active profile's live secrets are read. Fails
        closed: if the config/secret lookup itself raises (e.g. a profile secret that
        can't be resolved in the current scope), that is reported as an unavailable
        reason rather than propagated — neither this method nor is_available() ever
        raises to a Hermes caller.
        """
        try:
            import betterdb_agent_memory  # noqa: F401
        except Exception:
            return "betterdb-agent-memory is not installed (pip install betterdb-agent-memory)."
        try:
            config = _Config(self._config_input)
        except Exception as exc:
            return f"BetterDB memory configuration could not be resolved: {exc}"
        if not config.has_connection():
            return "No Valkey connection configured (set memory.betterdb.host or BETTERDB_MEMORY_URL)."
        if not (self._embed_fn is not None or config.embeddings.is_configured()):
            return (
                "Embeddings are not configured. betterdb-agent-memory does not ship an "
                "embedding model, so this provider needs an OpenAI-compatible endpoint. "
                "Set memory.betterdb.embeddings_api_key (OpenAI), or point "
                "memory.betterdb.embeddings_base_url at a local server (Ollama, vLLM, LM Studio)."
            )
        if config.embeddings.is_insecure():
            return (
                "Refusing to send the embeddings API key over plaintext http://. Use an "
                "https:// embeddings_base_url, or drop embeddings_api_key for a local "
                "keyless endpoint."
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
            {"key": "discovery",
             "description": "Register a discovery marker so BetterDB Monitor can enumerate this tier (opt-in)",
             "type": "boolean", "default": "false", "choices": ["true", "false"]},
            {"key": "embeddings_model", "description": "Embeddings model",
             "default": DEFAULT_EMBEDDINGS_MODEL},
            {"key": "embeddings_base_url",
             "description": "OpenAI-compatible embeddings endpoint. Defaults to OpenAI; point at "
                            "Ollama, vLLM or LM Studio to run locally without a key.",
             "default": DEFAULT_EMBEDDINGS_BASE_URL},
            {"key": "embeddings_api_key",
             "description": "API key for the embeddings endpoint (OpenAI or a compatible gateway). "
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

        # Resolve config live under the active profile's scope and keep it for
        # operational use (client build, scoping) for the life of the provider.
        self._config = _Config(self._config_input)

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
                discovery=self._config.discovery,
            )

        # Create the vector index up front, off the calling thread. The store is
        # unusable until the index exists, but a turn should never block on it.
        self._submit(self._store.ensure_index(), label="ensure_index")
        # Register this tier for discovery, mirroring the SDK's AgentMemory facade
        # (ensure_discovery_ready after ensure_index under a running loop). Skipped
        # when discovery is disabled, and guarded so an injected store without the
        # hook doesn't break initialize.
        if self._config.discovery:
            ensure_discovery = getattr(self._store, "ensure_discovery_ready", None)
            if callable(ensure_discovery):
                self._submit(ensure_discovery(), label="discovery")

    def _build_client(self) -> Any:
        """Construct a ``valkey.asyncio`` client from the resolved config."""
        import valkey.asyncio as valkey  # type: ignore

        if self._config.url:
            # Gap-fill: a URL may omit auth/db, so pass any separately-configured
            # fields as from_url kwargs (a user who provides URL +
            # BETTERDB_MEMORY_PASSWORD isn't silently unauthenticated). Note the
            # direction of precedence — valkey-py merges the URL's own components
            # last, so credentials/db embedded in the URL win over these kwargs;
            # the separate fields only fill what the URL leaves out.
            url = self._config.url
            if self._config.tls:
                url = _tls_url(url)
                if not url.startswith(("valkeys://", "rediss://")):
                    raise ValueError(
                        "betterdb memory: tls is enabled but the url scheme "
                        f"{self._config.url.partition('://')[0]!r} cannot be upgraded to TLS "
                        "(e.g. unix://); use a TLS-capable scheme or disable tls")
            extra: Dict[str, Any] = {}
            if self._config.password:
                extra["password"] = self._config.password
            if self._config.username:
                extra["username"] = self._config.username
            if self._config._explicit_db:
                extra["db"] = self._config.db
            return valkey.Valkey.from_url(url, **extra)
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
        if session_id:
            self._session_id = session_id
        sid = session_id or self._session_id
        # Recall is best-effort and owns its own result handling (debug-level, since
        # a failure simply injects nothing), so skip the generic warning reporter.
        future = self._submit(
            self._store.recall(query, k=RECALL_K, agent_id=self._agent_id, **self._scope_kwargs()),
            label="recall",
            report=False,
        )
        if future is None:
            return

        def _on_done(fut: Any) -> None:
            try:
                hits = fut.result()
            except concurrent.futures.CancelledError:
                return
            except Exception as exc:  # recall is best-effort; a failure injects nothing
                logger.debug("betterdb recall failed: %s", exc)
                return
            block, count = self._format_recall(hits)
            with self._lock:
                self._recall_block = block
                self._recall_count = count
                self._recall_session = sid

        future.add_done_callback(_on_done)

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Return (and clear) the cached recall block. Fast — no network here.

        A block recalled for a different session is dropped rather than injected —
        the provider instance outlives a single chat (``/new``, ``/resume``), so a
        stale block must not leak into the next one.
        """
        if session_id:
            self._session_id = session_id
        sid = session_id or self._session_id
        with self._lock:
            if self._recall_session == sid:
                block, count = self._recall_block, self._recall_count
            else:
                block, count = "", 0
            self._recall_block, self._recall_count, self._recall_session = "", 0, ""
            self._last_status = (
                RecallStatus(provider_label="BetterDB", count=count, glyph=INDICATOR_GLYPH)
                if block
                else None
            )
        return block

    def recall_status(self) -> Optional[RecallStatus]:
        return self._last_status

    def on_session_switch(
        self, new_session_id: str, *, parent_session_id: str = "", reset: bool = False,
        rewound: bool = False, **kwargs: Any,
    ) -> None:
        """The agent's session_id rotated (/new, /resume, /branch, compression).

        The provider instance is reused across these, so adopt the new session and
        drop any recall cached for the old one — otherwise a write lands under the
        previous session or the last chat's recall block leaks into this one.
        """
        if not new_session_id:
            return
        self._session_id = new_session_id
        with self._lock:
            self._recall_block, self._recall_count, self._recall_session = "", 0, ""
            self._last_status = None

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
        if session_id:
            self._session_id = session_id
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
                        importance=_clamp01(_as_float(args.get("importance"), 0.7)),
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
        except (concurrent.futures.TimeoutError, TimeoutError):
            # str(TimeoutError()) is "" — surface a real message, not {"error": ""}.
            return tool_error("BetterDB memory timed out after 10s")
        except Exception as exc:
            return tool_error(str(exc))

    # -- shutdown ---------------------------------------------------------- #

    def shutdown(self) -> None:
        store, runtime = self._store, self._runtime
        client, embed_fn = self._client, self._embed_fn
        # Null the embedder too: aclose() marks it closed for good, so a later
        # initialize() must build a fresh one rather than reuse the dead handle.
        self._store = self._runtime = self._client = self._embed_fn = None
        if runtime is not None:
            # Quiesce in-flight background work BEFORE releasing the resources it
            # uses, so a queued embed/remember can't rebuild a client on a loop that
            # is about to stop. Then tear down on the loop, ordered by dependency:
            # close the store first (its discovery/analytics teardown still needs a
            # live client), then release the Valkey client pool and the shared
            # embeddings HTTP client, and only then stop the loop.
            drain = getattr(runtime, "drain", None)
            if callable(drain):
                drain()
            self._run_quiet(runtime, store.close() if store is not None else None, "store close")
            self._run_quiet(runtime, self._aclose(client), "client close")
            self._run_quiet(runtime, self._aclose(embed_fn), "embedder close")
            runtime.stop(drain=False)  # already drained above

    @staticmethod
    def _aclose(obj: Any) -> Any:
        """Return ``obj.aclose()`` coroutine when available, else None (skipped)."""
        aclose = getattr(obj, "aclose", None)
        return aclose() if callable(aclose) else None

    @staticmethod
    def _run_quiet(runtime: Any, coro: Any, label: str) -> None:
        if coro is None:
            return
        try:
            runtime.run(coro, timeout=5.0)
        except Exception as exc:
            logger.warning("betterdb %s failed: %s", label, exc)

    # -- internals --------------------------------------------------------- #

    def _should_write(self) -> bool:
        # Only the primary agent context persists; subagent/cron/flush runs read.
        return self._agent_context == "primary"

    def _scope_kwargs(self) -> Dict[str, Any]:
        return {"namespace": self._config.namespace} if self._config.namespace else {}

    def _submit(self, coro: Any, *, label: str, report: bool = True) -> Any:
        """Fire-and-forget a coroutine onto the runtime loop.

        Unless *report* is False, attach a done-callback that surfaces a failed
        background job at ``logger.warning`` — otherwise these writes/index builds
        fail silently. Callers that own their own result handling (recall) pass
        ``report=False``.
        """
        if not self._runtime:
            return None
        try:
            future = self._runtime.submit(coro)
        except Exception as exc:
            logger.warning("betterdb %s submit failed: %s", label, exc)
            return None
        if report:
            future.add_done_callback(lambda f: self._report_background(f, label))
        return future

    @staticmethod
    def _report_background(future: Any, label: str) -> None:
        """Done-callback: log a background job's failure (never swallow it silently)."""
        try:
            future.result()
        except concurrent.futures.CancelledError:
            return
        except Exception as exc:
            logger.warning("betterdb %s failed: %s", label, exc)


def register(ctx) -> None:
    """Module-level registration hook (plugin dir + entry point both call this)."""
    ctx.register_memory_provider(BetterDBMemoryProvider())
