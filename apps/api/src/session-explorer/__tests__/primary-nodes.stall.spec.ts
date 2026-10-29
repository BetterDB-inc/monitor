import { createServer, type Server, type Socket } from 'net';
import { ServiceUnavailableException } from '@nestjs/common';
import Valkey from 'iovalkey';
import { withPrimaries } from '../primary-nodes';
import { fakeDb, type FakeValkey } from './fake-valkey';

const listen = async (onSocket: (socket: Socket) => void) => {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    onSocket(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
  return { server, port, close };
};

const dbOn = (port: number) => {
  const parent = new Valkey({ host: '127.0.0.1', port, lazyConnect: true });
  parent.on('error', () => undefined);
  return { parent, db: fakeDb(parent as unknown as FakeValkey) };
};

describe('withPrimaries against a real socket', () => {
  let stalled: Awaited<ReturnType<typeof listen>>;
  let full: Awaited<ReturnType<typeof listen>>;

  beforeAll(async () => {
    stalled = await listen(() => undefined);
    full = await listen((socket) => socket.end('-ERR max number of clients reached\r\n'));
  });

  afterAll(async () => {
    await stalled.close();
    await full.close();
  });

  it('gives up on a stalled server when the shared client has no command timeout', async () => {
    const { parent, db } = dbOn(stalled.port);
    const run = jest.fn();
    const started = Date.now();

    await expect(withPrimaries(db, run)).rejects.toThrow(ServiceUnavailableException);

    expect(run).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(8_000);
    parent.disconnect();
  }, 15_000);

  it('reports a server at maxclients unavailable instead of reading on a dead reader', async () => {
    const { parent, db } = dbOn(full.port);
    const run = jest.fn();

    await expect(withPrimaries(db, run)).rejects.toThrow(ServiceUnavailableException);

    expect(run).not.toHaveBeenCalled();
    parent.disconnect();
  }, 15_000);
});
