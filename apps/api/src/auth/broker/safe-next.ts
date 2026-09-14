const MAX_NEXT_LENGTH = 512;

export function safeNext(next: unknown): string {
  if (typeof next !== 'string') {
    return '/';
  }
  if (next.startsWith('/') === false || next.startsWith('//') === true) {
    return '/';
  }
  if (next.includes('\\') === true || next.length > MAX_NEXT_LENGTH) {
    return '/';
  }
  return next;
}
