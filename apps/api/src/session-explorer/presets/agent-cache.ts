import type { KeyView, ParsedMessage } from '@betterdb/shared';
import type { PresetDefinition } from './types';
import { fail, guardedParse, isRecord, parseJson, textContent } from './text';

const SESSION_KEY = /:session:(.+?):(?:__checkpoint_latest$|checkpoint:|writes:)/;
const CHECKPOINT_MARKER = ':checkpoint:';
const LATEST_SUFFIX = ':__checkpoint_latest';
const WRITES_MARKER = ':writes:';

const ROLE_BY_CONSTRUCTOR: Record<string, string> = {
  HumanMessage: 'human',
  AIMessage: 'ai',
  SystemMessage: 'system',
  ToolMessage: 'tool',
};

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
  const constructorName = entry.id[entry.id.length - 1];
  const role = typeof constructorName === 'string' ? ROLE_BY_CONSTRUCTOR[constructorName] : undefined;
  if (!role) return fail('Unknown message constructor');
  const kwargs = entry.kwargs;
  const message: ParsedMessage = { role, content: textContent(kwargs.content) };
  const toolCalls = parseToolCalls(kwargs.tool_calls);
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
  if (!Array.isArray(messages)) return fail('Checkpoint has no message list');
  return messages.map(parseMessage);
}

const isCheckpointKey = (key: string) =>
  key.includes(CHECKPOINT_MARKER) || key.endsWith(LATEST_SUFFIX);

const checkpointId = (key: string) =>
  key.slice(key.indexOf(CHECKPOINT_MARKER) + CHECKPOINT_MARKER.length);

function newestCheckpoint(keys: KeyView[]): KeyView | undefined {
  const latest = keys.find((v) => v.parsed && v.key.endsWith(LATEST_SUFFIX));
  if (latest) return latest;
  return keys
    .filter((v) => v.parsed && v.key.includes(CHECKPOINT_MARKER))
    .sort((a, b) => (checkpointId(a.key) < checkpointId(b.key) ? -1 : 1))
    .pop();
}

export const agentCachePreset: PresetDefinition = {
  id: 'agent-cache',
  defaultPattern: (prefix) => `${prefix}:session:*`,
  sessionIdOf: (key) => SESSION_KEY.exec(key)?.[1] ?? null,
  parseKey: (k) =>
    guardedParse(k, () => {
      if (k.type !== 'string') return fail('Expected a string value');
      if (isCheckpointKey(k.key)) return parseCheckpoint(k.value);
      if (k.key.includes(WRITES_MARKER)) {
        if (typeof k.value !== 'string') return fail('Expected a string value');
        parseJson(k.value);
        return [];
      }
      return fail('Unrecognised agent-cache field');
    }),
  mergeSession: (views) => {
    const newest = newestCheckpoint(views);
    return newest && newest.parsed ? newest.messages : [];
  },
};
