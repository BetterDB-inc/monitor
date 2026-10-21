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

describe('validateSample / hash field TTLs', () => {
  const unknownCommand = new Error("ERR unknown command 'HPTTL'");

  function hashClient(ttls: number[] | Error, fieldCount = 2): Valkey & { call: jest.Mock } {
    const fields: Buffer[] = [];
    for (let i = 0; i < fieldCount; i++) fields.push(Buffer.from(`f${i}`), Buffer.from(`v${i}`));
    const mock = {
      scan: jest.fn().mockResolvedValue(['0', ['h']]),
      pipeline: jest.fn().mockReturnValue({
        type: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([[null, 'hash']]),
      }),
      type: jest.fn().mockResolvedValue('hash'),
      hlen: jest.fn().mockResolvedValue(fieldCount),
      hscanBuffer: jest.fn().mockResolvedValue(['0', fields]),
      call: jest
        .fn()
        .mockImplementation(() => (ttls instanceof Error ? Promise.reject(ttls) : Promise.resolve(ttls))),
    };
    return mock as unknown as Valkey & { call: jest.Mock };
  }

  it('flags field TTLs that did not reach the target', async () => {
    const result = await validateSample(hashClient([5000, -1]), hashClient([-1, -1]), 10);

    expect(result.valueMismatches).toBe(1);
    expect(result.issues[0].detail).toBe('1 field TTL(s) missing on target');
  });

  it('flags field TTLs that exist only on the target', async () => {
    const result = await validateSample(hashClient([-1, -1]), hashClient([-1, 4000]), 10);

    expect(result.issues[0].detail).toBe('1 field(s) have a TTL on target but not on source');
  });

  it('compares TTL presence, not remaining time', async () => {
    const result = await validateSample(hashClient([5000, -1]), hashClient([4900, -1]), 10);

    expect(result.matched).toBe(1);
  });

  it('does not fail when either side lacks HFE', async () => {
    const a = await validateSample(hashClient(unknownCommand), hashClient([5000, -1]), 10);
    const b = await validateSample(hashClient([5000, -1]), hashClient(unknownCommand), 10);

    expect(a.matched).toBe(1);
    expect(b.matched).toBe(1);
  });

  it('does not read HPTTL for hashes over 100 fields', async () => {
    const source = hashClient([5000], 150);
    const target = hashClient([-1], 150);

    const result = await validateSample(source, target, 10);

    expect(result.matched).toBe(1);
    expect(source.call).not.toHaveBeenCalled();
    expect(target.call).not.toHaveBeenCalled();
  });
});
