import { safeNext } from './safe-next';

describe('safeNext', () => {
  it.each([
    [undefined, '/'],
    ['', '/'],
    ['/settings?tab=mcp', '/settings?tab=mcp'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example', '/'],
    ['settings', '/'],
    [`/${'a'.repeat(600)}`, '/'],
  ])('%s -> %s', (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });
});
