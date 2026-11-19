import Valkey from 'iovalkey';
import { UnifiedDatabaseAdapter } from '../unified.adapter';

jest.mock('iovalkey');

function createMockClient() {
  const client = {
    options: { host: 'localhost', port: 6379 },
    status: 'wait',
    on: jest.fn(),
    connect: jest.fn().mockImplementation(async () => {
      client.status = 'ready';
    }),
    quit: jest.fn().mockImplementation(async () => {
      client.status = 'end';
    }),
    disconnect: jest.fn().mockImplementation(() => {
      client.status = 'end';
    }),
    config: jest.fn().mockResolvedValue(['maxmemory', '0']),
    call: jest.fn().mockResolvedValue('PONG'),
    info: jest.fn((section?: string) =>
      Promise.resolve(section === 'server' ? '# Server\r\nredis_version:7.2.0\r\n' : ''),
    ),
  };
  return client;
}

describe('UnifiedDatabaseAdapter reconnecting its main client', () => {
  let created: Array<ReturnType<typeof createMockClient>>;

  beforeEach(() => {
    created = [];
    jest.mocked(Valkey).mockImplementation(() => {
      const client = createMockClient();
      created.push(client);
      return client as unknown as Valkey;
    });
  });

  const connectWithCliSession = async (): Promise<UnifiedDatabaseAdapter> => {
    const adapter = new UnifiedDatabaseAdapter({ host: 'localhost', port: 6379 });
    await adapter.connect();
    await adapter.call('PING', [], { cli: true });
    return adapter;
  };

  it('closes and reconnects the main client', async () => {
    const adapter = await connectWithCliSession();
    const [main] = created;

    await adapter.reconnectClient();

    expect(main.disconnect).toHaveBeenCalledTimes(1);
    expect(main.connect).toHaveBeenCalledTimes(2);
    expect(adapter.isConnected()).toBe(true);
  });

  it('leaves the CLI client open', async () => {
    const adapter = await connectWithCliSession();
    const [, cli] = created;

    await adapter.reconnectClient();

    expect(cli.quit).not.toHaveBeenCalled();
    expect(cli.disconnect).not.toHaveBeenCalled();
    expect(cli.status).toBe('ready');
    expect(created).toHaveLength(2);
  });
});
