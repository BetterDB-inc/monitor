import { toWebHeaders } from './web-headers';

describe('toWebHeaders', () => {
  it('copies string headers and joins array headers', () => {
    const headers = toWebHeaders({
      cookie: 'a=1',
      'set-cookie': ['x=1', 'y=2'],
      host: undefined,
    });
    expect(headers.get('cookie')).toBe('a=1');
    expect(headers.get('set-cookie')).toBe('x=1, y=2');
    expect(headers.has('host')).toBe(false);
  });
});
