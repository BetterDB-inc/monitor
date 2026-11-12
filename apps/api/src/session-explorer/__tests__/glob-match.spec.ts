import { globMatches } from '../glob-match';

describe('globMatches', () => {
  it.each([
    ['chat:*', 'chat:1', true],
    ['chat:*', 'chat:', true],
    ['chat:*', 'chats:1', false],
    ['a?c', 'abc', true],
    ['a?c', 'ac', false],
    ['a[bc]d', 'acd', true],
    ['a[^bc]d', 'acd', false],
    ['a[^bc]d', 'aed', true],
    ['a[b-d]e', 'ace', true],
    ['a[b-d]e', 'aee', false],
    ['\\*x', '*x', true],
    ['\\*x', 'ax', false],
    ['a*b*c', 'axxbyyc', true],
    ['a*b*c', 'axxbyy', false],
    ['*:session:*', 'p:session:t', true],
  ])('%p against %p is %p', (pattern, key, expected) => {
    expect(globMatches(pattern, key)).toBe(expected);
  });

  it('settles a pattern with many stars against a long key quickly', () => {
    const pattern = `${'a*'.repeat(8)}b`;
    const key = 'a'.repeat(100_000);
    const started = Date.now();
    expect(globMatches(pattern, key)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
