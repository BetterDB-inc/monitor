import type { ParsedMessage } from '@betterdb/shared';
import type { PresetDefinition } from './types';
import { fail, guardedParse, isRecord, parseJson, textContent, toolUseCalls } from './text';

const ROLE_BY_TYPE = new Map([
  ['human', 'human'],
  ['ai', 'ai'],
  ['system', 'system'],
  ['tool', 'tool'],
  ['function', 'tool'],
  ['HumanMessageChunk', 'human'],
  ['AIMessageChunk', 'ai'],
  ['SystemMessageChunk', 'system'],
  ['ToolMessageChunk', 'tool'],
  ['FunctionMessageChunk', 'tool'],
]);

const CHAT_TYPES = new Set(['chat', 'generic', 'ChatMessageChunk']);

function roleOf(type: string, data: Record<string, unknown>): string {
  if (CHAT_TYPES.has(type)) {
    return typeof data.role === 'string' && data.role !== '' ? data.role : 'chat';
  }
  return ROLE_BY_TYPE.get(type) ?? fail(`Unknown message type "${type}"`);
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

function parseElement(element: unknown): ParsedMessage {
  if (typeof element !== 'string') return fail('List element is not a string');
  const envelope = parseJson(element);
  if (!isRecord(envelope) || typeof envelope.type !== 'string' || !isRecord(envelope.data)) {
    return fail('Element is not a {type, data} message envelope');
  }
  const data = envelope.data;
  const role = roleOf(envelope.type, data);
  const message: ParsedMessage = { role, content: textContent(data.content) };
  const toolCalls = parseToolCalls(data.tool_calls) ?? toolUseCalls(data.content);
  if (toolCalls) message.toolCalls = toolCalls;
  if (role === 'tool') {
    message.toolResult = {
      ...(typeof data.name === 'string' ? { name: data.name } : {}),
      content: message.content,
      ...(typeof data.tool_call_id === 'string' ? { callId: data.tool_call_id } : {}),
    };
  }
  return message;
}

export const langchainCommunityPreset: PresetDefinition = {
  id: 'langchain-community',
  defaultPattern: (prefix) => `${prefix}*`,
  sessionIdOf: (key) => key,
  parseKey: (k) =>
    guardedParse(k, () => {
      if (k.type !== 'list' || !Array.isArray(k.value)) return fail('Expected a list value');
      return [...k.value].reverse().map(parseElement);
    }),
  mergeSession: (views) =>
    views.flatMap((v) => (v.parsed ? v.messages : [])),
};
