export const MAX_GLOB_STARS = 8;

type Token =
  | { star: true; next: number }
  | { star: false; matches: (c: string) => boolean; next: number };

function classAt(pattern: string, at: number): Token {
  let i = at + 1;
  const negate = pattern[i] === '^';
  if (negate) i++;
  const ranges: Array<[string, string]> = [];
  while (i < pattern.length && pattern[i] !== ']') {
    if (pattern[i] === '\\' && i + 1 < pattern.length) {
      ranges.push([pattern[i + 1], pattern[i + 1]]);
      i += 2;
    } else if (pattern[i + 1] === '-' && i + 2 < pattern.length && pattern[i + 2] !== ']') {
      const [from, to] = [pattern[i], pattern[i + 2]].sort();
      ranges.push([from, to]);
      i += 3;
    } else {
      ranges.push([pattern[i], pattern[i]]);
      i++;
    }
  }
  return {
    star: false,
    matches: (c) => ranges.some(([from, to]) => c >= from && c <= to) !== negate,
    next: Math.min(i + 1, pattern.length),
  };
}

function tokenAt(pattern: string, at: number): Token {
  const c = pattern[at];
  if (c === '*') return { star: true, next: at + 1 };
  if (c === '?') return { star: false, matches: () => true, next: at + 1 };
  if (c === '[') return classAt(pattern, at);
  if (c === '\\' && at + 1 < pattern.length) {
    const literal = pattern[at + 1];
    return { star: false, matches: (k) => k === literal, next: at + 2 };
  }
  return { star: false, matches: (k) => k === c, next: at + 1 };
}

export function globMatches(pattern: string, key: string): boolean {
  let p = 0;
  let k = 0;
  let resumeP = -1;
  let resumeK = 0;
  while (k < key.length) {
    if (p < pattern.length) {
      const token = tokenAt(pattern, p);
      if (token.star) {
        p = resumeP = token.next;
        resumeK = k;
        continue;
      }
      if (token.matches(key[k])) {
        p = token.next;
        k++;
        continue;
      }
    }
    if (resumeP < 0) return false;
    p = resumeP;
    k = ++resumeK;
  }
  while (p < pattern.length) {
    const token = tokenAt(pattern, p);
    if (!token.star) return false;
    p = token.next;
  }
  return true;
}
