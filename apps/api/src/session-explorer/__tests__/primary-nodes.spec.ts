import Valkey from 'iovalkey';
import { withPrimaries } from '../primary-nodes';
import { FakeValkey, fakeDb, masterNode } from './fake-valkey';

jest.mock('iovalkey', () => ({ __esModule: true, default: jest.fn() }));

const ValkeyMock = Valkey as unknown as jest.Mock;

const otherPrimaryOptions = async (parentOptions: Record<string, unknown>) => {
  const parent = new FakeValkey(new Map(), parentOptions);
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

  it('gives other primaries the shared client command timeout', async () => {
    const options = await otherPrimaryOptions({ host: 'seed', port: 7000, commandTimeout: 30_000 });

    expect(options).toMatchObject({ commandTimeout: 30_000, connectTimeout: 5000 });
  });

  it('sets no command timeout on other primaries when the shared client has none', async () => {
    const options = await otherPrimaryOptions({ host: 'seed', port: 7000 });

    expect(options.commandTimeout).toBeUndefined();
    expect(options.connectTimeout).toBe(5000);
  });
});
