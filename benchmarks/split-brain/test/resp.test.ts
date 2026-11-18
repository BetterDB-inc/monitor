import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { closeConnections, command } from '../src/resp';

const message = (settled: PromiseSettledResult<unknown>) =>
  settled.status === 'rejected' ? (settled.reason as Error).message : 'no error';

test('a command that times out does not lend its name to the others on the connection', async () => {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  try {
    const [slow, other] = await Promise.allSettled([
      command(port, ['PING', 'slow'], 200),
      command(port, ['PING', 'other'], 5_000),
    ]);
    assert.equal(message(slow), 'PING slow timed out');
    assert.equal(message(other), 'PING other failed: the connection was closed after PING slow timed out');
  } finally {
    await closeConnections([port]);
    for (const socket of sockets) socket.destroy();
    server.close();
  }
});
