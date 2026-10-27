import {
  escapeGlob,
  globLiteralPrefix,
  type CapturedKey,
  type KeyView,
  type ParsedMessage,
} from '@betterdb/shared';
import type { PresetDefinition } from './types';
import {
  chatRole,
  fail,
  guardedParse,
  isRecord,
  parseJson,
  parseToolCalls,
  textContent,
  toolResultOf,
  toolUseCalls,
} from './text';

const SESSION_MARKER = ':session:';
const CHECKPOINT_MARKER = ':checkpoint:';
const LATEST_SUFFIX = ':__checkpoint_latest';
const WRITES_MARKER = ':writes:';

const ROLE_BY_CONSTRUCTOR = new Map([
  ['HumanMessage', 'human'],
  ['AIMessage', 'ai'],
  ['SystemMessage', 'system'],
  ['ToolMessage', 'tool'],
  ['HumanMessageChunk', 'human'],
  ['AIMessageChunk', 'ai'],
  ['SystemMessageChunk', 'system'],
  ['ToolMessageChunk', 'tool'],
  ['FunctionMessage', 'tool'],
  ['FunctionMessageChunk', 'tool'],
]);

const CHAT_CONSTRUCTORS = new Set(['ChatMessage', 'ChatMessageChunk']);

function roleOf(constructorName: unknown, kwargs: Record<string, unknown>): string {
  if (typeof constructorName !== 'string') return fail('Unknown message constructor');
  if (CHAT_CONSTRUCTORS.has(constructorName)) return chatRole(kwargs.role);
  return ROLE_BY_CONSTRUCTOR.get(constructorName) ?? fail('Unknown message constructor');
}

function parseMessage(entry: unknown): ParsedMessage {
  if (
    !isRecord(entry) ||
    entry.lc !== 1 ||
    entry.type !== 'constructor' ||
    !Array.isArray(entry.id) ||
    !isRecord(entry.kwargs)
  ) {
    return fail('Message is not an lc-serialized constructor');
  }
  const kwargs = entry.kwargs;
  const role = roleOf(entry.id[entry.id.length - 1], kwargs);
  const message: ParsedMessage = { role, content: textContent(kwargs.content) };
  const toolCalls = parseToolCalls(kwargs.tool_calls) ?? toolUseCalls(kwargs.content);
  if (toolCalls) message.toolCalls = toolCalls;
  if (role === 'tool') message.toolResult = toolResultOf(message.content, kwargs);
  return message;
}

const ROLE_BY_TYPE = new Map([
  ['human', 'human'],
  ['user', 'human'],
  ['ai', 'ai'],
  ['assistant', 'ai'],
  ['system', 'system'],
  ['developer', 'system'],
  ['tool', 'tool'],
  ['function', 'tool'],
]);

const rawRole = (type: unknown): string =>
  (typeof type === 'string' && ROLE_BY_TYPE.get(type)) || fail('Unknown message role');

function parseRawMessage(entry: Record<string, unknown>): ParsedMessage {
  const role = rawRole(entry.role ?? entry.type);
  const message: ParsedMessage = { role, content: textContent(entry.content) };
  const toolCalls = parseToolCalls(entry.tool_calls) ?? toolUseCalls(entry.content);
  if (toolCalls) message.toolCalls = toolCalls;
  if (role === 'tool') message.toolResult = toolResultOf(message.content, entry);
  return message;
}

function parseWritten(entry: unknown): ParsedMessage {
  if (typeof entry === 'string') return { role: 'human', content: entry };
  if (Array.isArray(entry) && entry.length === 2) {
    return parseRawMessage({ role: entry[0], content: entry[1] });
  }
  if (isRecord(entry) && entry.lc === 1) return parseMessage(entry);
  if (isRecord(entry)) return parseRawMessage(entry);
  return fail('Write is not a message');
}

function parseCheckpoint(value: unknown): ParsedMessage[] {
  if (typeof value !== 'string') return fail('Expected a string value');
  const doc = parseJson(value);
  if (!isRecord(doc) || !isRecord(doc.checkpoint) || !isRecord(doc.checkpoint.channel_values)) {
    return fail('Value is not a checkpoint');
  }
  const messages = doc.checkpoint.channel_values.messages;
  if (messages === undefined) return [];
  if (!Array.isArray(messages)) return fail('Checkpoint messages are not a list');
  return messages.map(parseMessage);
}

interface WriteKey {
  checkpointId: string;
  taskId: string;
  channel: string;
  idx: number;
}

type KeyParts =
  | { threadId: string; kind: 'latest' | 'field' }
  | { threadId: string; kind: 'checkpoint'; checkpointId: string }
  | { threadId: string; kind: 'write'; write: WriteKey };

interface Entry {
  key: string;
  parts: KeyParts | null;
}

function writeOf(tail: string): WriteKey | null {
  if (tail.includes(':')) return null;
  const parts = tail.split('|');
  if (parts.length !== 4) return null;
  try {
    const [cid, taskId, channel] = parts.slice(0, 3).map(decodeURIComponent);
    return { checkpointId: cid, taskId, channel, idx: Number(parts[3]) };
  } catch {
    return null;
  }
}

function partsOf(rest: string): KeyParts | null {
  if (rest.endsWith(LATEST_SUFFIX)) {
    return { threadId: rest.slice(0, -LATEST_SUFFIX.length), kind: 'latest' };
  }
  const writeAt = rest.lastIndexOf(WRITES_MARKER);
  const checkpointAt = rest.lastIndexOf(CHECKPOINT_MARKER);
  if (writeAt > checkpointAt) {
    const write = writeOf(rest.slice(writeAt + WRITES_MARKER.length));
    if (write) return { threadId: rest.slice(0, writeAt), kind: 'write', write };
  }
  if (checkpointAt >= 0) {
    const checkpointId = rest.slice(checkpointAt + CHECKPOINT_MARKER.length);
    if (!checkpointId.includes(':')) {
      return { threadId: rest.slice(0, checkpointAt), kind: 'checkpoint', checkpointId };
    }
  }
  const at = rest.indexOf(':');
  return at >= 0 ? { threadId: rest.slice(0, at), kind: 'field' } : null;
}

function sessionBase(pattern: string | undefined): string | null {
  if (pattern === undefined) return null;
  const literal = globLiteralPrefix(pattern);
  const at = literal.lastIndexOf(SESSION_MARKER);
  return at >= 0 ? literal.slice(0, at + SESSION_MARKER.length) : null;
}

const isCheckpoint = (parts: KeyParts | null) =>
  parts?.kind === 'latest' || parts?.kind === 'checkpoint';

const maxId = (ids: string[]): string | undefined =>
  ids.reduce<string | undefined>((newest, id) => (newest === undefined || id > newest ? id : newest), undefined);

const checkpointIds = (entries: Entry[]) =>
  entries.flatMap(({ parts }) => (parts?.kind === 'checkpoint' ? [parts.checkpointId] : []));

function newestCheckpointKey(entries: Entry[]): string | undefined {
  const latest = entries.find(({ parts }) => parts?.kind === 'latest');
  if (latest) return latest.key;
  const id = maxId(checkpointIds(entries));
  return entries.find(({ parts }) => parts?.kind === 'checkpoint' && parts.checkpointId === id)?.key;
}

const newestCheckpointId = (entries: Entry[]): string | undefined =>
  maxId([
    ...checkpointIds(entries),
    ...entries.flatMap(({ parts }) => (parts?.kind === 'write' ? [parts.write.checkpointId] : [])),
  ]);

const pendingOrder = (a: WriteKey, b: WriteKey) =>
  a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : a.idx - b.idx;

function pendingMessages(
  views: KeyView[],
  entries: Entry[],
  newestId: string | undefined,
): ParsedMessage[] {
  if (newestId === undefined) return [];
  return views
    .map((view, i) => ({ view, parts: entries[i].parts }))
    .flatMap(({ view, parts }) =>
      parts?.kind === 'write' && parts.write.checkpointId === newestId && parts.write.channel === 'messages'
        ? [{ view, write: parts.write }]
        : [],
    )
    .sort((a, b) => pendingOrder(a.write, b.write))
    .flatMap(({ view }) => (view.parsed ? view.messages : []));
}

const defaultPattern = (prefix: string) =>
  `${escapeGlob(prefix.replace(/:+$/, ''))}${SESSION_MARKER}*`;

function parseWrite(value: string): ParsedMessage[] {
  const written = parseJson(value);
  return (Array.isArray(written) ? written : [written]).map(parseWritten);
}

const skipKey = (k: CapturedKey): KeyView =>
  guardedParse(k, () => (k.type === 'string' ? [] : fail('Expected a string value')));

export function createAgentCachePreset(pattern?: string): PresetDefinition {
  const base = sessionBase(pattern);

  const restOf = (key: string): string | null => {
    if (base !== null) return key.startsWith(base) ? key.slice(base.length) : null;
    const at = key.indexOf(SESSION_MARKER);
    return at >= 0 ? key.slice(at + SESSION_MARKER.length) : null;
  };

  const partsOfKey = (key: string): KeyParts | null => {
    const rest = restOf(key);
    return rest === null ? null : partsOf(rest);
  };

  const entriesOf = (keys: string[]): Entry[] =>
    keys.map((key) => ({ key, parts: partsOfKey(key) }));

  const selectKeys = (keys: string[]): string[] => {
    const entries = entriesOf(keys);
    const newest = newestCheckpointKey(entries);
    const newestId = newestCheckpointId(entries);
    return entries
      .filter(({ key, parts }) => {
        if (isCheckpoint(parts)) return key === newest;
        if (parts?.kind !== 'write') return true;
        return parts.write.checkpointId === newestId;
      })
      .map(({ key }) => key);
  };

  const parseKey = (k: CapturedKey): KeyView =>
    guardedParse(k, () => {
      if (k.type !== 'string' || typeof k.value !== 'string') return fail('Expected a string value');
      const parts = partsOfKey(k.key);
      if (isCheckpoint(parts)) return parseCheckpoint(k.value);
      if (parts?.kind === 'write' && parts.write.channel === 'messages') return parseWrite(k.value);
      return [];
    });

  return {
    id: 'agent-cache',
    defaultPattern,
    sessionIdOf: (key) => partsOfKey(key)?.threadId || null,
    sessionLookup: (sessionId) => ({
      match: `${base === null ? `*${SESSION_MARKER}` : escapeGlob(base)}${escapeGlob(sessionId)}:*`,
    }),
    parseKey,
    selectKeys,
    parseKeys: (keys) => {
      const selected = new Set(selectKeys(keys.map((k) => k.key)));
      return keys.map((k) => (selected.has(k.key) ? parseKey(k) : skipKey(k)));
    },
    mergeSession: (views) => {
      const entries = entriesOf(views.map((v) => v.key));
      const newest = newestCheckpointKey(entries);
      const view = views.find((v) => v.key === newest);
      if (!view || !view.parsed) return [];
      return [...view.messages, ...pendingMessages(views, entries, newestCheckpointId(entries))];
    },
  };
}
