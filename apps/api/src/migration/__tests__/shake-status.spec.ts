import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { fetchShakeStatus, findFreePort, parseShakeStatus } from '../execution/shake-status';

const aof = (received: number, sent: number) => ({
  status: 'syncing aof',
  aof_received_offset: received,
  aof_sent_offset: sent,
});

describe('parseShakeStatus', () => {
  it('reads a standalone reader as src-0', () => {
    expect(parseShakeStatus({ consistent: true, reader: aof(500, 500) })).toEqual({
      consistent: true,
      shards: [{ shard: 'src-0', inAof: true, diff: 0 }],
    });
  });

  it('reads cluster readers in order as src-0..N-1', () => {
    expect(parseShakeStatus({ consistent: false, reader: [aof(900, 400), aof(700, 700)] })).toEqual({
      consistent: false,
      shards: [
        { shard: 'src-0', inAof: true, diff: 500 },
        { shard: 'src-1', inAof: true, diff: 0 },
      ],
    });
  });

  it('reports unknown lag before the first AOF entry is sent', () => {
    expect(parseShakeStatus({ consistent: false, reader: aof(207075874, 0) })?.shards).toEqual([
      { shard: 'src-0', inAof: true, diff: null },
    ]);
  });

  it('reports unknown lag when sent is ahead of received', () => {
    expect(parseShakeStatus({ consistent: false, reader: aof(100, 105) })?.shards[0].diff).toBeNull();
  });

  it('marks a shard outside AOF as not in AOF with unknown lag', () => {
    expect(
      parseShakeStatus({ consistent: false, reader: { status: 'syncing rdb', aof_received_offset: 0, aof_sent_offset: 0 } })
        ?.shards,
    ).toEqual([{ shard: 'src-0', inAof: false, diff: null }]);
  });

  it('returns null for a body it does not recognise', () => {
    for (const body of [null, 'x', {}, { consistent: true }, { consistent: 'yes', reader: aof(1, 1) }, { consistent: true, reader: [] }]) {
      expect(parseShakeStatus(body)).toBeNull();
    }
  });
});

describe('findFreePort', () => {
  it('returns a usable TCP port', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });
});

describe('fetchShakeStatus', () => {
  let server: Server;
  let port: number;
  let body: string;

  beforeEach(async () => {
    body = JSON.stringify({ consistent: true, reader: aof(10, 10) });
    server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('parses the status JSON from the port', async () => {
    await expect(fetchShakeStatus(port, 1000)).resolves.toEqual({
      consistent: true,
      shards: [{ shard: 'src-0', inAof: true, diff: 0 }],
    });
  });

  it('returns null for an invalid body', async () => {
    body = 'not json';
    await expect(fetchShakeStatus(port, 1000)).resolves.toBeNull();
  });

  it('returns null when nothing listens on the port', async () => {
    const closed = await findFreePort();
    await expect(fetchShakeStatus(closed, 1000)).resolves.toBeNull();
  });
});
