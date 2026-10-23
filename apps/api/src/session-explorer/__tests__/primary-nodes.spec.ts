import Valkey from 'iovalkey';
import { withPrimaries } from '../primary-nodes';
import { FakeValkey, fakeDb, masterNode } from './fake-valkey';

jest.mock('iovalkey', () => ({ __esModule: true, default: jest.fn() }));

const ValkeyMock = Valkey as unknown as jest.Mock;

const noTouchCalls = (client: FakeValkey) =>
  client.callsOf('call').filter((c) => c.args[0] === 'CLIENT' && c.args[1] === 'NO-TOUCH');

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

  it('falls back to the shared connection when a reader cannot connect', async () => {
    const parent = new FakeValkey();
    const reader = new FakeValkey();
    reader.connectError = new Error('ECONNREFUSED');
    parent.duplicateWith = reader;

    const used = await withPrimaries(fakeDb(parent), async ({ clients }) => clients);

    expect(used).toEqual([parent]);
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

  it('turns on NO-TOUCH for every cluster primary it connects to', async () => {
    const parent = new FakeValkey();
    const self = new FakeValkey();
    parent.duplicateWith = self;
    const other = new FakeValkey();
    ValkeyMock.mockImplementation(() => other);
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
});
