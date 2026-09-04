import type { ActivityCursor } from '../common/interfaces/activity-repository.interface';

const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

export function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(`${cursor.occurredAt}:${cursor.id}`, 'utf8').toString('base64url');
}

export function decodeActivityCursor(raw: string): ActivityCursor | null {
  if (CURSOR_PATTERN.test(raw) === false) {
    return null;
  }
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator <= 0 || separator === decoded.length - 1) {
    return null;
  }
  const occurredAt = Number(decoded.slice(0, separator));
  if (Number.isSafeInteger(occurredAt) === false || occurredAt < 0) {
    return null;
  }
  return { occurredAt, id: decoded.slice(separator + 1) };
}
