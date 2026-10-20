import type Valkey from 'iovalkey';
import { validateSample } from '../validation/sample-validator';

describe('validateSample / streams', () => {
  function client(groups: unknown[]): Valkey {
    const mock = {
      scan: jest.fn().mockResolvedValue(['0', ['jobs']]),
      pipeline: jest.fn().mockReturnValue({
        type: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([[null, 'stream']]),
      }),
      type: jest.fn().mockResolvedValue('stream'),
      exists: jest.fn().mockResolvedValue(1),
      xlen: jest.fn().mockResolvedValue(4),
      call: jest
        .fn()
        .mockImplementation((cmd: string, sub: string) =>
          Promise.resolve(cmd === 'XINFO' && sub === 'GROUPS' ? groups : null),
        ),
    };
    return mock as unknown as Valkey;
  }
  const workers = ['name', 'workers', 'consumers', 1, 'pending', 2, 'last-delivered-id', '3-0'];

  it('flags a stream whose consumer groups did not reach the target', async () => {
    const result = await validateSample(client([workers]), client([]), 10);

    expect(result.valueMismatches).toBe(1);
    expect(result.issues[0].detail).toBe(
      'consumer groups differ (source: workers@3-0, target: none)',
    );
  });

  it('matches when groups and their last-delivered IDs agree', async () => {
    const result = await validateSample(client([workers]), client([workers]), 10);

    expect(result.matched).toBe(1);
    expect(result.issues).toEqual([]);
  });
});
