import type { ParsedMessage } from '@betterdb/shared';
import type { PresetDefinition } from './types';
import {
  concatSession,
  fail,
  guardedParse,
  isRecord,
  parseJson,
  parseToolCalls,
  textContent,
  toolResultOf,
  type ToolCall,
} from './text';

const ROLE_MAP = new Map([
  ['user', 'human'],
  ['assistant', 'ai'],
  ['system', 'system'],
  ['developer', 'system'],
  ['tool', 'tool'],
  ['function', 'tool'],
  ['chatbot', 'ai'],
  ['model', 'ai'],
]);

const HIDDEN_BLOCKS = new Set(['tool_call', 'cache', 'citation']);

function blocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return fail('blocks is not a list');
  return blocks
    .flatMap((block) => {
      if (!isRecord(block) || typeof block.block_type !== 'string') {
        return fail('Unsupported content block');
      }
      if (block.block_type === 'text' && typeof block.text === 'string') return [block.text];
      if (HIDDEN_BLOCKS.has(block.block_type)) return [];
      return [`[${block.block_type}]`];
    })
    .join('\n');
}

const withId = (id: unknown) => (typeof id === 'string' ? { id } : {});

function argsOf(args: unknown): unknown {
  if (isRecord(args)) return args;
  if (typeof args !== 'string') return fail('Tool call arguments are not a string or object');
  try {
    return parseJson(args);
  } catch {
    return args;
  }
}

function parseToolCall(call: unknown): ToolCall {
  if (!isRecord(call)) return fail('Malformed tool call');
  if (isRecord(call.function) && typeof call.function.name === 'string') {
    return { name: call.function.name, args: argsOf(call.function.arguments), ...withId(call.id) };
  }
  if (typeof call.name === 'string') {
    return { name: call.name, args: call.input, ...withId(call.id) };
  }
  return fail('Malformed tool call');
}

function blockToolCalls(blocks: unknown[]): ParsedMessage['toolCalls'] {
  const calls = blocks.filter(
    (block): block is Record<string, unknown> =>
      isRecord(block) && block.block_type === 'tool_call' && typeof block.tool_name === 'string',
  );
  if (calls.length === 0) return undefined;
  return calls.map((block) => ({
    name: block.tool_name as string,
    args: block.tool_kwargs,
    ...withId(block.tool_call_id),
  }));
}

function parseElement(element: unknown): ParsedMessage {
  if (typeof element !== 'string') return fail('List element is not a string');
  const msg = parseJson(element);
  if (!isRecord(msg) || typeof msg.role !== 'string') {
    return fail('Element is not a {role, blocks} message');
  }
  const role = ROLE_MAP.get(msg.role);
  if (!role) return fail(`Unknown role "${msg.role}"`);
  const kwargs = msg.additional_kwargs;
  if (kwargs !== undefined && !isRecord(kwargs)) return fail('additional_kwargs is not an object');
  const extras = kwargs ?? {};
  const legacy = msg.blocks === undefined;
  const content = legacy ? textContent(msg.content ?? '') : blocksText(msg.blocks);
  const message: ParsedMessage = { role, content };
  const toolCalls =
    parseToolCalls(extras.tool_calls, parseToolCall) ??
    (legacy ? undefined : blockToolCalls(msg.blocks as unknown[]));
  if (toolCalls) message.toolCalls = toolCalls;
  if (role === 'tool') message.toolResult = toolResultOf(message.content, extras);
  return message;
}

export const llamaindexPreset: PresetDefinition = {
  id: 'llamaindex',
  defaultPattern: (prefix) => `${prefix}*`,
  sessionIdOf: (key) => key,
  parseKey: (k) =>
    guardedParse(k, () => {
      if (k.type !== 'list' || !Array.isArray(k.value)) return fail('Expected a list value');
      return k.value.map(parseElement);
    }),
  mergeSession: concatSession,
};
