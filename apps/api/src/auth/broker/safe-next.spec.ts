import { safeNext } from './safe-next';

describe('safeNext', () => {
  it.each([
    [undefined, '/'],
    ['', '/'],
    ['/settings?tab=mcp', '/settings?tab=mcp'],
    ['/search?q=%E2%82%AC#top', '/search?q=%E2%82%AC#top'],
    ['/a b', '/a b'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example', '/'],
    ['settings', '/'],
    [`/${'a'.repeat(600)}`, '/'],
    ['/\r\nset-cookie: x=1', '/'],
    ['/a\rb', '/'],
    ['/a\nb', '/'],
    ['/a\tb', '/'],
    ['/a\u0000b', '/'],
    ['/a\u001fb', '/'],
    ['/a\u007fb', '/'],
    ['/a\u00a0b', '/'],
    ['/caf\u00e9', '/'],
    ['/a\u2028b', '/'],
    ['/\u{1F600}', '/'],
  ])('%j -> %s', (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });
});
