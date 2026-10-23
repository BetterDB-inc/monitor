import type { CapturedKey, KeyView, ParsedMessage } from '@betterdb/shared';
import type { PresetDefinition } from './types';

const MAX_UTF8_TAIL = 3;

const strictDecoder = new TextDecoder('utf-8', { fatal: true });

const tryDecode = (buf: Buffer): string | null => {
  try {
    return strictDecoder.decode(buf);
  } catch {
    return null;
  }
};

const isContinuation = (byte: number) => (byte & 0xc0) === 0x80;

const sequenceLength = (lead: number) =>
  lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;

function incompleteTail(buf: Buffer): number {
  let start = buf.length - 1;
  while (start > 0 && buf.length - start < MAX_UTF8_TAIL && isContinuation(buf[start])) start--;
  if (start < 0) return 0;
  const tail = buf.length - start;
  const lead = buf[start];
  if (lead < 0xc2 || lead > 0xf4) return 0;
  return sequenceLength(lead) > tail ? tail : 0;
}

export function decodeValue(
  buf: Buffer,
  cap: number,
  more = false,
): { value: string; binary: boolean; truncated: boolean } {
  const truncated = more || buf.length > cap;
  const slice = truncated ? buf.subarray(0, cap) : buf;
  const full = tryDecode(slice);
  if (full !== null) {
    return { value: full, binary: false, truncated };
  }
  const tail = truncated ? incompleteTail(slice) : 0;
  const trimmed = tail > 0 ? tryDecode(slice.subarray(0, slice.length - tail)) : null;
  if (trimmed !== null) {
    return { value: trimmed, binary: false, truncated };
  }
  return { value: slice.toString('base64'), binary: true, truncated };
}

export function estimateTokens(messages: ParsedMessage[]): number {
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(chars / 4);
}

export const ttlOf = (k: CapturedKey): number | null => (k.pttl >= 0 ? k.pttl : null);

export const parsedView = (k: CapturedKey, messages: ParsedMessage[]): KeyView => ({
  key: k.key,
  type: k.type,
  ttlMs: ttlOf(k),
  raw: k.value,
  binary: k.binary === true,
  truncated: k.truncated === true,
  parsed: true,
  messages,
});

export const failedView = (k: CapturedKey, reason: string): KeyView => ({
  key: k.key,
  type: k.type,
  ttlMs: ttlOf(k),
  raw: k.value,
  binary: k.binary === true,
  truncated: k.truncated === true,
  parsed: false,
  reason,
});

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export class ShapeError extends Error {}

export const fail = (reason: string): never => {
  throw new ShapeError(reason);
};

export const readableValue = (k: CapturedKey): string | null => {
  if (k.truncated === true) return 'Value truncated at the byte cap';
  if (k.binary === true) return 'Value is not valid UTF-8';
  return null;
};

export function guardedParse(k: CapturedKey, parse: () => ParsedMessage[]): KeyView {
  const unreadable = readableValue(k);
  if (unreadable !== null) return failedView(k, unreadable);
  try {
    return parsedView(k, parse());
  } catch (err) {
    if (err instanceof ShapeError) return failedView(k, err.message);
    if (err instanceof SyntaxError) return failedView(k, 'Value is not valid JSON');
    throw err;
  }
}

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

const TOOL_CALL_BLOCKS = new Set(['tool_use', 'tool_call', 'tool_call_chunk']);

export function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .flatMap((part) => {
        if (typeof part === 'string') return [part];
        if (!isRecord(part) || typeof part.type !== 'string') {
          return fail('Unsupported content block');
        }
        if (part.type === 'text' && typeof part.text === 'string') return [part.text];
        if (TOOL_CALL_BLOCKS.has(part.type)) return [];
        return [`[${part.type}]`];
      })
      .join('\n');
  }
  return fail('Message content is not text');
}

export const withId = (id: unknown) => (typeof id === 'string' ? { id } : {});

export function toolUseCalls(content: unknown): ParsedMessage['toolCalls'] {
  if (!Array.isArray(content)) return undefined;
  const calls = content.filter(
    (part): part is Record<string, unknown> =>
      isRecord(part) && part.type === 'tool_use' && typeof part.name === 'string',
  );
  if (calls.length === 0) return undefined;
  return calls.map((part) => ({
    name: part.name as string,
    args: part.input,
    ...withId(part.id),
  }));
}

export type ToolCall = NonNullable<ParsedMessage['toolCalls']>[number];

function langchainToolCall(call: unknown): ToolCall {
  if (!isRecord(call) || typeof call.name !== 'string') {
    return fail('Malformed tool call');
  }
  return {
    name: call.name,
    args: call.args,
    ...withId(call.id),
  };
}

export function parseToolCalls(
  raw: unknown,
  parseCall: (call: unknown) => ToolCall = langchainToolCall,
): ParsedMessage['toolCalls'] {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return fail('tool_calls is not a list');
  if (raw.length === 0) return undefined;
  return raw.map(parseCall);
}

export const chatRole = (role: unknown): string =>
  typeof role === 'string' && role !== '' ? role : 'chat';

export const toolResultOf = (
  content: string,
  source: Record<string, unknown>,
): ParsedMessage['toolResult'] => ({
  ...(typeof source.name === 'string' ? { name: source.name } : {}),
  content,
  ...(typeof source.tool_call_id === 'string' ? { callId: source.tool_call_id } : {}),
});

export const concatSession: PresetDefinition['mergeSession'] = (views) =>
  views.flatMap((v) => (v.parsed ? v.messages : []));
