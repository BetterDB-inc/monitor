import type { CapturedKey, KeyView, ParsedMessage } from '@betterdb/shared';
import type { PresetDefinition } from './types';
import { fail, guardedParse, isRecord, parseJson, textContent, toolUseCalls } from './text';

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
  if (CHAT_CONSTRUCTORS.has(constructorName)) {
    return typeof kwargs.role === 'string' && kwargs.role !== '' ? kwargs.role : 'chat';
  }
  return ROLE_BY_CONSTRUCTOR.get(constructorName) ?? fail('Unknown message constructor');
}

function parseToolCalls(raw: unknown): ParsedMessage['toolCalls'] {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return fail('tool_calls is not a list');
  if (raw.length === 0) return undefined;
  return raw.map((call) => {
    if (!isRecord(call) || typeof call.name !== 'string') {
      return fail('Malformed tool call');
    }
    return {
      name: call.name,
      args: call.args,
      ...(typeof call.id === 'string' ? { id: call.id } : {}),
    };
  });
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
  if (role === 'tool') {
    message.toolResult = {
      ...(typeof kwargs.name === 'string' ? { name: kwargs.name } : {}),
      content: message.content,
      ...(typeof kwargs.tool_call_id === 'string' ? { callId: kwargs.tool_call_id } : {}),
    };
  }
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

function newestCheckpointKey(keys: string[]): string | undefined {
  const latest = keys.find((key) => key.endsWith(LATEST_SUFFIX));
  if (latest) return latest;
  return keys
    .filter((key) => key.includes(CHECKPOINT_MARKER))
    .reduce<string | undefined>(
      (newest, key) =>
        newest === undefined || checkpointId(key) > checkpointId(newest) ? key : newest,
      undefined,
    );
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

const parseKey = (k: CapturedKey): KeyView =>
  guardedParse(k, () => {
    if (k.type !== 'string' || typeof k.value !== 'string') return fail('Expected a string value');
    if (isCheckpointKey(k.key)) return parseCheckpoint(k.value);
    if (k.key.includes(WRITES_MARKER)) parseJson(k.value);
    return [];
  });

const skipKey = (k: CapturedKey): KeyView =>
  guardedParse(k, () => (k.type === 'string' ? [] : fail('Expected a string value')));

export const agentCachePreset: PresetDefinition = {
  id: 'agent-cache',
  defaultPattern: (prefix) => `${prefix}:session:*`,
  sessionIdOf,
  parseKey,
  parseKeys: (keys) => {
    const newest = newestCheckpointKey(keys.map((k) => k.key));
    return keys.map((k) => (isCheckpointKey(k.key) && k.key !== newest ? skipKey(k) : parseKey(k)));
  },
  mergeSession: (views) => {
    const newest = newestCheckpointKey(views.map((v) => v.key));
    const view = views.find((v) => v.key === newest);
    return view && view.parsed ? view.messages : [];
  },
};
