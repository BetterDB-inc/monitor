import { nextStreamId } from '../execution/stream-metadata';

describe('stream-metadata / nextStreamId', () => {
  it.each([
    ['5-0', '5-1'],
    ['1700000000000-41', '1700000000000-42'],
    ['7', '7-1'],
    ['1-18446744073709551614', '1-18446744073709551615'],
    ['1-18446744073709551615', '2-0'],
  ])('%s -> %s', (id, next) => {
    expect(nextStreamId(id)).toBe(next);
  });
});
