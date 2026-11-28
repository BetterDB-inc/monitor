export const INVALID_CURSOR_MESSAGE = 'Invalid cursor';

export interface KeysetCursor {
  at: number;
  id: string;
}

const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

export function encodeKeysetCursor(at: number, id: string): string {
  return Buffer.from(`${at}:${id}`, 'utf8').toString('base64url');
}

export function decodeKeysetCursor(raw: string): KeysetCursor | null {
  if (CURSOR_PATTERN.test(raw) === false) {
    return null;
  }
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator <= 0 || separator === decoded.length - 1) {
    return null;
  }
  const at = Number(decoded.slice(0, separator));
  if (Number.isSafeInteger(at) === false || at < 0) {
    return null;
  }
  return { at, id: decoded.slice(separator + 1) };
}
