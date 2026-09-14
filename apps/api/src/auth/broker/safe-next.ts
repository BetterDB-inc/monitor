const MAX_NEXT_LENGTH = 512;
const FIRST_PRINTABLE = 0x20;
const LAST_PRINTABLE = 0x7e;

function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < FIRST_PRINTABLE || code > LAST_PRINTABLE) {
      return true;
    }
  }
  return false;
}

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
  if (hasUnsafeCharacter(next) === true) {
    return '/';
  }
  return next;
}
