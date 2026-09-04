import { decodeActivityCursor, encodeActivityCursor } from './activity-cursor';

describe('activity cursor', () => {
  it('round-trips a cursor', () => {
    const cursor = { occurredAt: 1_700_000_000_000, id: 'abc-123' };
    expect(decodeActivityCursor(encodeActivityCursor(cursor))).toEqual(cursor);
  });

  it('returns null for garbage', () => {
    expect(decodeActivityCursor('')).toBeNull();
    expect(decodeActivityCursor('not base64url!')).toBeNull();
    expect(decodeActivityCursor(Buffer.from('nope').toString('base64url'))).toBeNull();
    expect(decodeActivityCursor(Buffer.from('x:abc').toString('base64url'))).toBeNull();
  });
});
