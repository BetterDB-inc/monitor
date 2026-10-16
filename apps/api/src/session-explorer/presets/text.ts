import type { CapturedKey, KeyView, ParsedMessage } from '@betterdb/shared';

const MAX_UTF8_TAIL = 3;

const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const tryDecode = (buf: Buffer): string | null => {
  try {
    return strictDecoder.decode(buf);
  } catch {
    return null;
  }
};

export function decodeValue(
  buf: Buffer,
  cap: number,
): { value: string | { base64: string }; truncated: boolean } {
  const truncated = buf.length > cap;
  const slice = truncated ? buf.subarray(0, cap) : buf;
  const full = tryDecode(slice);
  if (full !== null) {
    return { value: full, truncated };
  }
  if (truncated) {
    for (let trim = 1; trim <= MAX_UTF8_TAIL && trim < slice.length; trim++) {
      const decoded = tryDecode(slice.subarray(0, slice.length - trim));
      if (decoded !== null) {
        return { value: decoded, truncated };
      }
    }
  }
  return { value: { base64: slice.toString('base64') }, truncated };
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
  truncated: k.truncated === true,
  parsed: true,
  messages,
});

export const failedView = (k: CapturedKey, reason: string): KeyView => ({
  key: k.key,
  type: k.type,
  ttlMs: ttlOf(k),
  raw: k.value,
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
  if (isRecord(k.value) && typeof k.value.base64 === 'string') {
    return 'Value is not valid UTF-8';
  }
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

export function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
          return part.text;
        }
        return fail('Unsupported content block');
      })
      .join('');
  }
  return fail('Message content is not text');
}
