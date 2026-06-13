import { describe, it, expect } from 'vitest';
import { escapeTag } from '../tags';

describe('escapeTag', () => {
  it('escapes punctuation used by the TAG filter syntax', () => {
    expect(escapeTag('a,b')).toBe('a\\,b');
    expect(escapeTag('a.b')).toBe('a\\.b');
    expect(escapeTag('a{b}')).toBe('a\\{b\\}');
    expect(escapeTag('a|b')).toBe('a\\|b');
  });

  it('escapes spaces to prevent OR semantics', () => {
    expect(escapeTag('gpt 4o')).toBe('gpt\\ 4o');
  });

  it('escapes hyphens and slashes', () => {
    expect(escapeTag('gpt-4o')).toBe('gpt\\-4o');
    expect(escapeTag('a/b\\c')).toBe('a\\/b\\\\c');
  });

  it('leaves alphanumerics and underscores untouched', () => {
    expect(escapeTag('model_v2')).toBe('model_v2');
  });
});
