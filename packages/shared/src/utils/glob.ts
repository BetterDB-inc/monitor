const GLOB_SPECIAL = /[\\*?[\]]/g;
const GLOB_WILDCARDS = new Set(['*', '?', '[']);

export const escapeGlob = (value: string): string =>
  value.replace(GLOB_SPECIAL, (c) => `\\${c}`);

export function globLiteralPrefix(pattern: string): string {
  let literal = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) {
      literal += pattern[++i];
    } else if (GLOB_WILDCARDS.has(c)) {
      break;
    } else {
      literal += c;
    }
  }
  return literal;
}
