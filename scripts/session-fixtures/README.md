# Session fixtures harness

Seeds the compose `valkey` (6380) and `valkey-bundle` (6384) with chat/session
data written by real client libraries, then captures every key into committed
fixtures under `apps/api/test/fixtures/session-explorer/`. Parsers in the
Session Explorer are tested against these captures.

```
docker compose up -d valkey valkey-bundle
zsh scripts/session-fixtures/run.sh              # seed + capture
zsh scripts/session-fixtures/run.sh --seed-only  # seed only
```

Safety: only ports 6380 and 6384 are accepted. The harness never flushes; it
writes under `sxfix:` prefixes and deletes only keys matching its own prefixes
(SCAN + UNLINK) before seeding. Password comes from `VALKEY_PASSWORD`
(default `devpassword`). No LLM is called; messages are built with each
library's message classes and written through its own history/store/saver API.

Environment: Python 3.12.15 (venv in `.venv`, needs >= 3.10), Node 22.22.3,
Valkey 8.1.6 on 6380.

## Sessions seeded per library

`multi-turn` (system + 3 human/ai pairs), `tool-call` (human, ai with tool
call, tool result, ai), `long` (one 20 000 char message), `unicode`
(Bulgarian, emoji, CJK), `ttl` (3600 s TTL, others none), `oversize`
(> 1 MiB total `MEMORY USAGE`). `expectations[sessionId]` carries
`messages`, `toolCalls`, `roles` (canonical `system|human|ai|tool`, even where
the library stores `user`/`assistant`), `hasTtl` and, for every session except
`oversize`, `contents` in seeded order. Message content is defined once in
`session-spec.json`.

## Pinned versions

| Library | Version | Fixture |
| --- | --- | --- |
| langchain-community | 0.4.2 | `langchain-community@0.4.2.json` |
| llama-index-storage-chat-store-redis | 0.8.0 (llama-index-core 0.14.25) | `llamaindex@0.8.0.json` |
| @langchain/redis | 1.1.3 (@langchain/core 1.2.18) | `langchain-js@1.1.3.json` |
| @betterdb/agent-cache | 0.12.0 (BetterDBSaver, @langchain/langgraph-checkpoint 1.2.0) | `agent-cache@0.12.0.json` |
| langchain-redis | 0.2.6 (langchain-core 1.6.11, redis 8.1.0, redisvl 0.28.0) | none, see below |

## langchain-redis: not captured

`langchain-redis` 0.2.6 cannot run against valkey-bundle 6384 (valkey-search
1.2.1). The constructor calls `SearchIndex.create()`, which fails with:

```
redisvl.exceptions.RedisSearchError: Error while fetching sxfix:idx:lcr index info: Index with name 'sxfix:idx:lcr' not found in database 0
```

Pre-creating the index with `FT.CREATE` gets past that check but then
`FT.INFO` parsing fails:

```
redisvl.exceptions.RedisSearchError: Error while fetching sxfix:idx:lcr index info: 'list' object has no attribute 'get'
```

No other server was used. The seeder was removed. Key layout from the library
source (not captured): JSON documents at `<key_prefix><session_id>:<ulid>` with
`type`, `message_id`, `data{content,additional_kwargs,type}`, `session_id`,
`timestamp`; top-level `tool_calls` is not persisted.

## Captured formats

Fixture shape: `{ library, version, preset, namespace, capturedAt, valkey,
keys[{key,type,pttl,value}], expectations }`. `pttl` is `-1` when no TTL.

### langchain-community (preset `langchain-community`)

- Key: `<key_prefix><session_id>`, e.g. `sxfix:lcc:multi-turn` (default prefix
  `message_store:`). One key per session.
- Type: `list`. Messages are `LPUSH`ed, so index 0 is the newest message;
  reverse for chronological order. TTL is applied to the single key.
- Element: JSON string (python `json.dumps`, non-ASCII escaped as `\uXXXX`)
  `{"type": "human|ai|system|tool", "data": {content, additional_kwargs,
  response_metadata, type, name, id, ...}}`.
- AI tool calls: `data.tool_calls: [{name, args, id, type: "tool_call"}]`.
  Tool results: `type: "tool"`, `data.tool_call_id`, `data.name`, `data.status`.

### langchain-js (`@langchain/redis`, preset `langchain-js`)

- Key: the `sessionId` verbatim, e.g. `sxfix:lcjs:multi-turn`. One key per
  session, `list`, `LPUSH` (newest first), TTL on the key.
- Element: compact JSON `{"type": "...", "data": {content, tool_calls,
  invalid_tool_calls, additional_kwargs, response_metadata}}`; tool messages add
  `tool_call_id` and `name`; non-ASCII is not escaped.
- Same envelope as langchain-community (`{type, data}`, same type names, same
  `data.tool_calls` and `data.tool_call_id` fields, newest first). It only
  differs in JSON whitespace/escaping and in missing `name`/`id`/`usage_metadata`
  keys, which a JSON parser does not see. Decision: Task 3 registers it as an
  alias of the langchain-community parser, no `langchain-js.ts`.

### llamaindex (`RedisChatStore`, preset `llamaindex`)

- Key: the key passed by the caller, e.g. `sxfix:li:multi-turn` (no library
  prefix). One key per session, `list`, `RPUSH` (oldest first), TTL on the key.
- Element: JSON `{"role": "system|user|assistant|tool", "additional_kwargs":
  {...}, "blocks": [{"block_type": "text", "text": "..."}]}`. Content is in
  `blocks[].text`, there is no `content` field.
- Tool calls (OpenAI style, as the llama OpenAI integration writes them):
  `additional_kwargs.tool_calls: [{id, type: "function", function: {name,
  arguments: "<json string>"}}]` on the assistant message. Tool results:
  `role: "tool"`, `additional_kwargs.tool_call_id` and `name`.

### agent-cache (`BetterDBSaver` over `SessionStore`, preset `agent-cache`)

- Keys (cache name `sxfix:ac`): `<name>:session:<thread_id>:<field>`, all
  `string`, with fields:
  - `checkpoint:<checkpoint_id>`: one per checkpoint (uuid6 id).
  - `__checkpoint_latest`: byte-identical copy of the newest checkpoint value.
  - `writes:<checkpoint_id>|<task_id>|<channel>|<idx>` (URL-encoded parts):
    pending writes, value is `JSON.stringify(writeValue)`.
  - Non-session key under the prefix: `<name>:__stats` (`hash`,
    `{"session:writes": "<n>"}`).
- Checkpoint value: JSON `{config: {configurable: {thread_id, checkpoint_ns,
  checkpoint_id}}, checkpoint: {v, id, ts, channel_values: {messages: [...]},
  channel_versions, versions_seen, ...}, metadata: {source, step, parents}}`.
- Messages in `channel_values.messages` are LangChain lc-serialized
  constructors: `{"lc": 1, "type": "constructor", "id": ["langchain_core",
  "messages", "HumanMessage|AIMessage|SystemMessage|ToolMessage"], "kwargs":
  {content, tool_calls?, tool_call_id?, ...}}`. Each checkpoint holds the full
  history so far, so the newest checkpoint (`__checkpoint_latest`) is the
  authoritative message list. Sessions with at most 12 messages get one
  checkpoint per turn plus one `writes:` key each; `oversize` gets a single
  checkpoint and no writes, and uses 30 turns so the two checkpoint keys
  together exceed 1 MiB.
- TTL: applied to every key of the thread (`ttl` session only).
