import type { CapturedKey, KeyView, ParsedMessage } from '@betterdb/shared';
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

const isCheckpointKey = (key: string) =>
  key.includes(CHECKPOINT_MARKER) || key.endsWith(LATEST_SUFFIX);

const checkpointId = (key: string) =>
  key.slice(key.indexOf(CHECKPOINT_MARKER) + CHECKPOINT_MARKER.length);

interface WriteKey {
  checkpointId: string;
  taskId: string;
  channel: string;
  idx: number;
}

function writeOf(key: string): WriteKey | null {
  const at = key.indexOf(WRITES_MARKER);
  if (at < 0) return null;
  const parts = key.slice(at + WRITES_MARKER.length).split('|');
  if (parts.length !== 4) return null;
  try {
    const [cid, taskId, channel] = parts.slice(0, 3).map(decodeURIComponent);
    return { checkpointId: cid, taskId, channel, idx: Number(parts[3]) };
  } catch {
    return null;
  }
}

const maxId = (ids: string[]): string | undefined =>
  ids.reduce<string | undefined>((newest, id) => (newest === undefined || id > newest ? id : newest), undefined);

const checkpointIds = (keys: string[]) =>
  keys.filter((key) => key.includes(CHECKPOINT_MARKER)).map(checkpointId);

function newestCheckpointKey(keys: string[]): string | undefined {
  const latest = keys.find((key) => key.endsWith(LATEST_SUFFIX));
  if (latest) return latest;
  const id = maxId(checkpointIds(keys));
  return keys.find((key) => key.includes(CHECKPOINT_MARKER) && checkpointId(key) === id);
}

const newestCheckpointId = (keys: string[]): string | undefined =>
  maxId([
    ...checkpointIds(keys),
    ...keys.flatMap((key) => writeOf(key)?.checkpointId ?? []),
  ]);

function selectKeys(keys: string[]): string[] {
  const newest = newestCheckpointKey(keys);
  const newestId = newestCheckpointId(keys);
  return keys.filter((key) => {
    if (isCheckpointKey(key)) return key === newest;
    if (!key.includes(WRITES_MARKER)) return true;
    return newestId !== undefined && writeOf(key)?.checkpointId === newestId;
  });
}

const pendingOrder = (a: WriteKey, b: WriteKey) =>
  a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : a.idx - b.idx;

function pendingMessages(views: KeyView[], newestId: string | undefined): ParsedMessage[] {
  if (newestId === undefined) return [];
  return views
    .map((view) => ({ view, write: writeOf(view.key) }))
    .filter(
      (p): p is { view: KeyView; write: WriteKey } =>
        p.write !== null && p.write.checkpointId === newestId && p.write.channel === 'messages',
    )
    .sort((a, b) => pendingOrder(a.write, b.write))
    .flatMap(({ view }) => (view.parsed ? view.messages : []));
}

function sessionPrefix(key: string): string | null {
  if (key.endsWith(LATEST_SUFFIX)) return key.slice(0, -LATEST_SUFFIX.length);
  for (const marker of [CHECKPOINT_MARKER, WRITES_MARKER]) {
    const at = key.indexOf(marker);
    if (at >= 0) return key.slice(0, at);
  }
  const at = key.lastIndexOf(':');
  return at >= 0 ? key.slice(0, at) : null;
}

function sessionIdOf(key: string): string | null {
  const prefix = sessionPrefix(key);
  if (prefix === null) return null;
  const at = prefix.lastIndexOf(SESSION_MARKER);
  if (at < 0) return null;
  return prefix.slice(at + SESSION_MARKER.length) || null;
}

const escapeGlob = (text: string) => text.replace(/\\/g, '\\\\').replace(/([*?[\]])/g, '\\$1');

const defaultPattern = (prefix: string) =>
  `${escapeGlob(prefix.replace(/:+$/, ''))}${SESSION_MARKER}*`;

function parseWrite(value: string): ParsedMessage[] {
  const written = parseJson(value);
  return (Array.isArray(written) ? written : [written]).map(parseMessage);
}

const parseKey = (k: CapturedKey): KeyView =>
  guardedParse(k, () => {
    if (k.type !== 'string' || typeof k.value !== 'string') return fail('Expected a string value');
    if (isCheckpointKey(k.key)) return parseCheckpoint(k.value);
    if (writeOf(k.key)?.channel === 'messages') return parseWrite(k.value);
    return [];
  });

const skipKey = (k: CapturedKey): KeyView =>
  guardedParse(k, () => (k.type === 'string' ? [] : fail('Expected a string value')));

export const agentCachePreset: PresetDefinition = {
  id: 'agent-cache',
  defaultPattern,
  sessionIdOf,
  parseKey,
  selectKeys,
  parseKeys: (keys) => {
    const selected = new Set(selectKeys(keys.map((k) => k.key)));
    return keys.map((k) => (selected.has(k.key) ? parseKey(k) : skipKey(k)));
  },
  mergeSession: (views) => {
    const keys = views.map((v) => v.key);
    const newest = newestCheckpointKey(keys);
    const view = views.find((v) => v.key === newest);
    if (!view || !view.parsed) return [];
    return [...view.messages, ...pendingMessages(views, newestCheckpointId(keys))];
  },
};
