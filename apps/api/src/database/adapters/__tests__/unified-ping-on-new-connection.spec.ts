import { createServer, type AddressInfo, type Server, type Socket } from 'net';
import { UnifiedDatabaseAdapter } from '../unified.adapter';

const TIMEOUT_MS = 200;

describe('UnifiedDatabaseAdapter ping on a new connection', () => {
  let server: Server;
  let sockets: Socket[];
  let closed: Promise<void>;
  let reply: ((command: string) => string) | null;

  const commandsIn = (chunk: Buffer): string[] =>
    chunk
      .toString()
      .split(/(?=^\*\d+\r\n)/m)
      .filter((part) => part.length > 0);

  const listen = async (): Promise<number> => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  };

  beforeEach(() => {
    sockets = [];
    reply = null;
    let markClosed: () => void = () => undefined;
    closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => markClosed());
      socket.on('data', (chunk) => {
        if (!reply) return;
        for (const command of commandsIn(chunk)) socket.write(reply(command));
      });
    });
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('is true when the database answers, and closes the connection after', async () => {
    reply = () => '+PONG\r\n';
    const adapter = new UnifiedDatabaseAdapter({ host: '127.0.0.1', port: await listen() });

    await expect(adapter.pingOnNewConnection(TIMEOUT_MS)).resolves.toBe(true);

    await closed;
    expect(sockets).toHaveLength(1);
  });

  it('is true when the database answers the ping with an error', async () => {
    reply = (command) => (/PING/i.test(command) ? '-NOPERM no permission to run ping\r\n' : '+OK\r\n');
    const adapter = new UnifiedDatabaseAdapter({ host: '127.0.0.1', port: await listen() });

    await expect(adapter.pingOnNewConnection(TIMEOUT_MS)).resolves.toBe(true);
  });

  it('is false when the database accepts the connection and never answers', async () => {
    const adapter = new UnifiedDatabaseAdapter({ host: '127.0.0.1', port: await listen() });
    const started = Date.now();

    await expect(adapter.pingOnNewConnection(TIMEOUT_MS)).resolves.toBe(false);

    expect(sockets).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 5);
    await closed;
  });

  it('is false when the connection is refused', async () => {
    const port = await listen();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const adapter = new UnifiedDatabaseAdapter({ host: '127.0.0.1', port });

    await expect(adapter.pingOnNewConnection(TIMEOUT_MS)).resolves.toBe(false);
  });
});
