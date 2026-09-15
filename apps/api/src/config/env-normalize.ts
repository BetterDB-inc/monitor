export const DEFAULT_AUTH_BROKER_URL = 'https://betterdb.com';

export function isTrueFlag(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  return value.trim() === 'true';
}

export function normalizeOptionalUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '') {
    return null;
  }
  return trimmed;
}
