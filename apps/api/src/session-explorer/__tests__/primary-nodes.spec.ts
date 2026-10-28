import { ServiceUnavailableException } from '@nestjs/common';
import Valkey from 'iovalkey';
import { withPrimaries } from '../primary-nodes';
import { FakeValkey, fakeDb, masterNode } from './fake-valkey';

jest.mock('iovalkey', () => ({ __esModule: true, default: jest.fn() }));

const ValkeyMock = Valkey as unknown as jest.Mock;

const noTouchCalls = (client: FakeValkey) =>
  client.callsOf('call').filter((c) => c.args[0] === 'CLIENT' && c.args[1] === 'NO-TOUCH');

const otherPrimaryOptions = async (parentOptions: Record<string, unknown>) => {
  const parent = new FakeValkey(new Map(), parentOptions);
  parent.duplicateWith = new FakeValkey();
  ValkeyMock.mockImplementation(() => new FakeValkey());
  const db = fakeDb(parent, {
    nodes: [
      masterNode('a', '10.0.0.1:7000', ['myself'], [[0, 8191]]),
      masterNode('b', '10.0.0.2:7001', [], [[8192, 16383]]),
    ],
  });
  await withPrimaries(db, async ({ clients }) => clients);
  return ValkeyMock.mock.calls[0][0] as Record<string, unknown>;
};

describe('withPrimaries', () => {
  beforeEach(() => ValkeyMock.mockReset());

  it('reads a standalone server through its own NO-TOUCH connection', async () => {
    const parent = new FakeValkey();
    const reader = new FakeValkey();
    parent.duplicateWith = reader;

    const used = await withPrimaries(fakeDb(parent), async ({ clients }) => clients);

    expect(used).toEqual([reader]);
    expect(noTouchCalls(reader)).toHaveLength(1);
    expect(noTouchCalls(parent)).toHaveLength(0);
    expect(reader.disconnected).toBe(true);
    expect(parent.disconnected).toBe(false);
  });

  it('keeps the shared client command timeout on its own reader', async () => {
    const parent = new FakeValkey(new Map(), { host: 'seed', port: 7000, commandTimeout: 30_000 });
    parent.duplicateWith = new FakeValkey();

    await withPrimaries(fakeDb(parent), async ({ clients }) => clients);

    expect(parent.callsOf('duplicate')[0].args[0]).toMatchObject({ commandTimeout: 30_000 });
  });

  it('bounds commands on its own reader when the shared client has no timeout', async () => {
    const parent = new FakeValkey();
    parent.duplicateWith = new FakeValkey();

    await withPrimaries(fakeDb(parent), async ({ clients }) => clients);

    expect(parent.callsOf('duplicate')[0].args[0]).toMatchObject({ commandTimeout: 5000 });
  });

  it.each([
    'ERR max number of clients reached',
    'NOAUTH Authentication required.',
    'WRONGPASS invalid username-password pair or user is disabled.',
  ])('reports the server unavailable when it answers %s', async (message) => {
    const parent = new FakeValkey();
    const reader = new FakeValkey();
    reader.serverError = new Error(message);
    parent.duplicateWith = reader;
    const run = jest.fn();

    await expect(withPrimaries(fakeDb(parent), run)).rejects.toThrow(ServiceUnavailableException);

    expect(run).not.toHaveBeenCalled();
    expect(parent.disconnected).toBe(false);
  });

  it('still reads when the server does not know CLIENT NO-TOUCH', async () => {
    const parent = new FakeValkey();
    const reader = new FakeValkey();
    reader.noTouchError = new Error('ERR unknown subcommand');
    parent.duplicateWith = reader;

    const used = await withPrimaries(fakeDb(parent), async ({ clients }) => clients);

    expect(used).toEqual([reader]);
  });

  it('still reads when the user may not run CLIENT NO-TOUCH', async () => {
    const parent = new FakeValkey();
    const reader = new FakeValkey();
    reader.noTouchError = new Error(
      "NOPERM User reader has no permissions to run the 'client' command",
    );
    parent.duplicateWith = reader;

    const result = await withPrimaries(fakeDb(parent), async (p) => p);

    expect(result.clients).toEqual([reader]);
    expect(result.touchesKeys).toBe(true);
  });

  it('turns on NO-TOUCH for every cluster primary it connects to', async () => {
    const parent = new FakeValkey();
    const self = new FakeValkey();
    const other = new FakeValkey();
    parent.duplicateWith = self;
    ValkeyMock.mockImplementationOnce(() => other);
    const db = fakeDb(parent, {
      nodes: [
        masterNode('a', '10.0.0.1:7000', ['myself'], [[0, 8191]]),
        masterNode('b', '10.0.0.2:7001', [], [[8192, 16383]]),
      ],
    });

    const used = await withPrimaries(db, async ({ clients }) => clients);

    expect(used).toEqual([self, other]);
    expect(noTouchCalls(self)).toHaveLength(1);
    expect(noTouchCalls(other)).toHaveLength(1);
    expect(noTouchCalls(parent)).toHaveLength(0);
  });

  it('reads its own node through the reader that listed the topology', async () => {
    const parent = new FakeValkey(new Map(), { host: 'clustercfg.example.com', port: 6379 });
    const seed = new FakeValkey();
    parent.duplicateWith = seed;
    const db = fakeDb(parent, {
      nodes: [masterNode('a', '10.0.0.1:7000', ['myself'], [[0, 16383]])],
    });

    const used = await withPrimaries(db, async ({ clients }) => clients);

    expect(used).toEqual([seed]);
    expect(seed.callsOf('call').some((c) => c.args[0] === 'CLUSTER')).toBe(true);
    expect(parent.callsOf('call')).toHaveLength(0);
    expect(ValkeyMock).not.toHaveBeenCalled();
  });

  it('reads its own node when the address it announces cannot be parsed', async () => {
    const parent = new FakeValkey();
    const seed = new FakeValkey();
    parent.duplicateWith = seed;
    const db = fakeDb(parent, { nodes: [masterNode('a', ':7000', ['myself'], [[0, 16383]])] });

    const used = await withPrimaries(db, async ({ clients }) => clients);

    expect(used).toEqual([seed]);
  });

  it('reads the other primaries when one cannot be reached and counts its slots as failed', async () => {
    const parent = new FakeValkey();
    const seed = new FakeValkey();
    const unreachable = new FakeValkey();
    unreachable.connectError = new Error('ECONNREFUSED');
    parent.duplicateWith = seed;
    ValkeyMock.mockImplementation(() => unreachable);
    const db = fakeDb(parent, {
      nodes: [
        masterNode('a', '10.0.0.1:7000', ['myself'], [[0, 8191]]),
        masterNode('b', '10.0.0.2:7001', [], [[8192, 16383]]),
      ],
    });

    const result = await withPrimaries(db, async (p) => p);

    expect(result.clients).toEqual([seed]);
    expect(result.failed).toBe(1);
    expect(result.failedRoutes).toEqual([[[8192, 16383]]]);
  });

  it('reports the cluster unavailable when it lists no serving primary', async () => {
    const run = jest.fn();

    await expect(withPrimaries(fakeDb(new FakeValkey(), { nodes: [] }), run)).rejects.toThrow(
      ServiceUnavailableException,
    );

    expect(run).not.toHaveBeenCalled();
  });

  it('reports the cluster unavailable when the topology reader cannot open', async () => {
    const parent = new FakeValkey();
    const seed = new FakeValkey();
    seed.serverError = new Error('ERR max number of clients reached');
    parent.duplicateWith = seed;
    const run = jest.fn();
    const db = fakeDb(parent, {
      nodes: [masterNode('a', '10.0.0.1:7000', ['myself'], [[0, 16383]])],
    });

    await expect(withPrimaries(db, run)).rejects.toThrow(ServiceUnavailableException);
    expect(run).not.toHaveBeenCalled();
    expect(parent.callsOf('call')).toHaveLength(0);
  });

  it('reports that reads leave access times alone when every reader has NO-TOUCH', async () => {
    const parent = new FakeValkey();
    parent.duplicateWith = new FakeValkey();

    const result = await withPrimaries(fakeDb(parent), async (p) => p);

    expect(result.touchesKeys).toBe(false);
  });

  it('reports that reads touch keys when the server does not know CLIENT NO-TOUCH', async () => {
    const parent = new FakeValkey();
    const reader = new FakeValkey();
    reader.noTouchError = new Error('ERR unknown subcommand');
    parent.duplicateWith = reader;

    const result = await withPrimaries(fakeDb(parent), async (p) => p);

    expect(result.touchesKeys).toBe(true);
  });

  it('gives other primaries the shared client command timeout', async () => {
    const options = await otherPrimaryOptions({ host: 'seed', port: 7000, commandTimeout: 30_000 });

    expect(options).toMatchObject({ commandTimeout: 30_000, connectTimeout: 5000 });
  });

  it('bounds commands on other primaries when the shared client has no timeout', async () => {
    const options = await otherPrimaryOptions({ host: 'seed', port: 7000 });

    expect(options).toMatchObject({ commandTimeout: 5000, connectTimeout: 5000 });
  });

  it('releases the other primaries when the work throws', async () => {
    const node = new FakeValkey();
    ValkeyMock.mockImplementation(() => node);
    const db = fakeDb(new FakeValkey(), {
      nodes: [
        masterNode('a', '10.0.0.1:7000', ['myself'], [[0, 8191]]),
        masterNode('b', '10.0.0.2:7001', [], [[8192, 16383]]),
      ],
    });

    await expect(
      withPrimaries(db, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(node.disconnected).toBe(true);
  });
});
