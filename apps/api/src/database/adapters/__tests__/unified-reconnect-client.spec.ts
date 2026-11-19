import { createServer, type AddressInfo, type Server, type Socket } from 'net';
import { UnifiedDatabaseAdapter } from '../unified.adapter';

const SERVER_INFO = '# Server\r\nredis_version:7.2.0\r\n';

describe('UnifiedDatabaseAdapter reconnecting its main client', () => {
  let server: Server;
  let sockets: Socket[];
  let adapter: UnifiedDatabaseAdapter | undefined;

  const bulk = (text: string): string => `$${Buffer.byteLength(text)}\r\n${text}\r\n`;

  const commandsIn = (chunk: Buffer): string[] =>
    chunk
      .toString()
      .split(/(?=^\*\d+\r\n)/m)
      .filter((part) => part.length > 0);

  const replyTo = (command: string): string => {
    const name = command.split('\r\n')[2]?.toUpperCase();
    if (name === 'PING') return '+PONG\r\n';
    if (name === 'INFO') return bulk(SERVER_INFO);
    if (name === 'CONFIG') return `*2\r\n${bulk('maxmemory')}${bulk('0')}`;
    return '+OK\r\n';
  };

  const closedByClient = (socket: Socket): Promise<void> =>
    new Promise<void>((resolve) => {
      if (socket.destroyed) resolve();
      else socket.once('close', () => resolve());
    });

  beforeEach(async () => {
    sockets = [];
    adapter = undefined;
    server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => undefined);
      socket.on('data', (chunk) => {
        for (const command of commandsIn(chunk)) socket.write(replyTo(command));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await adapter?.disconnect().catch(() => undefined);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const connectWithCliSession = async (): Promise<UnifiedDatabaseAdapter> => {
    adapter = new UnifiedDatabaseAdapter({
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
    });
    await adapter.connect();
    await adapter.call('PING', [], { cli: true });
    return adapter;
  };

  it('closes the main connection and answers on a new one', async () => {
    const connected = await connectWithCliSession();
    const [main] = sockets;

    await connected.reconnectClient();

    await closedByClient(main);
    expect(connected.isConnected()).toBe(true);
    await expect(connected.ping()).resolves.toBe(true);
    expect(sockets).toHaveLength(3);
  });

  it('leaves the CLI connection open', async () => {
    const connected = await connectWithCliSession();
    const [, cli] = sockets;

    await connected.reconnectClient();

    expect(cli.destroyed).toBe(false);
    await expect(connected.call('PING', [], { cli: true })).resolves.toBe('PONG');
    expect(sockets).toHaveLength(3);
  });
});
