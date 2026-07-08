/* eslint-disable @typescript-eslint/no-explicit-any */
import { createValkeyScanTarget } from '../valkey-scan-target';

/** Fake iovalkey client capturing SCAN calls and pipelined UNLINKs. */
function makeClient() {
  const unlinked: string[] = [];
  const call = jest.fn(async (command: string, ...args: any[]) => {
    if (command === 'SCAN') return ['0', ['k1', 'k2']];
    throw new Error(`unexpected direct call: ${command}`);
  });
  const pipeline = jest.fn(() => {
    const ops: string[] = [];
    const chain: any = {
      unlink(key: string) {
        ops.push(key);
        return chain;
      },
      async exec() {
        unlinked.push(...ops);
        return ops.map((k) => [null, 1] as [null, number]);
      },
    };
    return chain;
  });
  return { client: { call, pipeline } as any, call, pipeline, unlinked };
}

describe('createValkeyScanTarget', () => {
  it('passes MATCH/COUNT and optional TYPE to SCAN', async () => {
    const { client, call } = makeClient();
    const target = createValkeyScanTarget('primary', client);

    const result = await target.scan('0', { match: 'a:*', count: 250, type: 'hash' });

    expect(call).toHaveBeenCalledWith('SCAN', '0', 'MATCH', 'a:*', 'COUNT', '250', 'TYPE', 'hash');
    expect(result).toEqual({ cursor: '0', keys: ['k1', 'k2'] });
  });

  it('omits TYPE when not provided', async () => {
    const { client, call } = makeClient();
    const target = createValkeyScanTarget('primary', client);

    await target.scan('7', { match: '*', count: 500 });

    expect(call).toHaveBeenCalledWith('SCAN', '7', 'MATCH', '*', 'COUNT', '500');
  });

  it('deletes per key via a pipeline (never a cross-slot variadic UNLINK)', async () => {
    const { client, call, pipeline, unlinked } = makeClient();
    const target = createValkeyScanTarget('primary', client);

    const removed = await target.unlink(['a', 'b', 'c']);

    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(unlinked).toEqual(['a', 'b', 'c']);
    expect(removed).toBe(3);
    // The CROSSSLOT-prone variadic form must NOT be used.
    expect(call).not.toHaveBeenCalledWith('UNLINK', expect.anything());
  });

  it('returns 0 for an empty key list without touching the client', async () => {
    const { client, pipeline } = makeClient();
    const target = createValkeyScanTarget('primary', client);

    expect(await target.unlink([])).toBe(0);
    expect(pipeline).not.toHaveBeenCalled();
  });

  it('sums only successful pipeline replies', async () => {
    const unlinked: string[] = [];
    const client: any = {
      pipeline: () => {
        const ops: string[] = [];
        const chain: any = {
          unlink(key: string) {
            ops.push(key);
            return chain;
          },
          async exec() {
            unlinked.push(...ops);
            // Second key errored, third already gone (0).
            return [
              [null, 1],
              [new Error('boom'), null],
              [null, 0],
            ];
          },
        };
        return chain;
      },
    };
    const target = createValkeyScanTarget('primary', client);

    expect(await target.unlink(['a', 'b', 'c'])).toBe(1);
  });
});
