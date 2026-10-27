import { createServer, type Server, type Socket } from 'net';
import Valkey from 'iovalkey';
import { withPrimaries } from '../primary-nodes';
import { fakeDb, type FakeValkey } from './fake-valkey';

describe('withPrimaries against a stalled server', () => {
  let server: Server;
  let port: number;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  it('times out a standalone read when the shared client has no command timeout', async () => {
    const parent = new Valkey({ host: '127.0.0.1', port, lazyConnect: true });
    parent.on('error', () => undefined);
    const db = fakeDb(parent as unknown as FakeValkey);
    const started = Date.now();

    await expect(withPrimaries(db, ({ clients }) => clients[0].get('k'))).rejects.toThrow(
      /timed out/i,
    );

    expect(Date.now() - started).toBeLessThan(12_000);
    parent.disconnect();
  }, 15_000);
});
