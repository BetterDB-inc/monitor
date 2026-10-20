import type { ParsedMessage } from '@betterdb/shared';
import type { PresetDefinition } from './types';
import { fail, guardedParse, isRecord, parseJson } from './text';

const ROLE_MAP: Record<string, string> = {
  user: 'human',
  assistant: 'ai',
  system: 'system',
  tool: 'tool',
};

type ToolCall = NonNullable<ParsedMessage['toolCalls']>[number];

function blocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return fail('blocks is not a list');
  return blocks
    .map((block) => {
      if (!isRecord(block) || typeof block.block_type !== 'string') {
        return fail('Unsupported content block');
      }
      if (block.block_type === 'text' && typeof block.text === 'string') return block.text;
      if (block.block_type === 'tool_call') return '';
      return `[${block.block_type}]`;
    })
    .join('');
}

const withId = (id: unknown) => (typeof id === 'string' ? { id } : {});

function argsOf(text: string): unknown {
  try {
    return parseJson(text);
  } catch {
    return text;
  }
}

function parseToolCall(call: unknown): ToolCall {
  if (!isRecord(call)) return fail('Malformed tool call');
  if (isRecord(call.function) && typeof call.function.name === 'string') {
    const argText = call.function.arguments;
    if (typeof argText !== 'string') return fail('Tool call arguments are not a string');
    return { name: call.function.name, args: argsOf(argText), ...withId(call.id) };
  }
  if (typeof call.name === 'string') {
    return { name: call.name, args: call.input, ...withId(call.id) };
  }
  return fail('Malformed tool call');
}

function parseToolCalls(raw: unknown): ParsedMessage['toolCalls'] {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return fail('tool_calls is not a list');
  if (raw.length === 0) return undefined;
  return raw.map(parseToolCall);
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
  const role = ROLE_MAP[msg.role];
  if (!role) return fail(`Unknown role "${msg.role}"`);
  const kwargs = msg.additional_kwargs;
  if (kwargs !== undefined && !isRecord(kwargs)) return fail('additional_kwargs is not an object');
  const extras = kwargs ?? {};
  const message: ParsedMessage = { role, content: blocksText(msg.blocks) };
  const toolCalls =
    parseToolCalls(extras.tool_calls) ?? blockToolCalls(msg.blocks as unknown[]);
  if (toolCalls) message.toolCalls = toolCalls;
  if (role === 'tool') {
    message.toolResult = {
      ...(typeof extras.name === 'string' ? { name: extras.name } : {}),
      content: message.content,
      ...(typeof extras.tool_call_id === 'string' ? { callId: extras.tool_call_id } : {}),
    };
  }
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
  mergeSession: (views) =>
    views.flatMap((v) => (v.parsed ? v.messages : [])),
};
