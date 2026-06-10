import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CaptureValkey } from '../CaptureValkey';
import type { CaptureValkeyOptions } from '../CaptureValkey';
import type { CapturedCommand } from '../types';
import { Redis } from 'iovalkey';
import Command from 'iovalkey/built/Command';

// Capture what fetch receives
let fetchCalls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
let fetchShouldFail = false;

vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
  if (fetchShouldFail) throw new Error('network error');
  fetchCalls.push({
    url,
    body: init?.body as string ?? '',
    headers: Object.fromEntries(Object.entries(init?.headers ?? {})),
  });
  if (url.includes('/window')) {
    return { ok: true, json: async () => ({ active: false }) } as Response;
  }
  return { ok: true } as Response;
}));

function makeClient(overrides?: Partial<CaptureValkeyOptions['capture']>): CaptureValkey {
  const client = new CaptureValkey({
    lazyConnect: true,
    capture: {
      token: 'test-token',
      monitorUrl: 'http://localhost:3000',
      instanceId: 'test-instance-1',
      batchSize: 5,
      flushIntervalMs: 60_000,
      maxBufferedCommands: 10,
      pollIntervalMs: 60_000,
      ...overrides,
    },
  } as CaptureValkeyOptions);

  // Stub super.sendCommand so it doesn't try to write to the wire.
  // We spy on the Redis prototype method and make it a no-op returning undefined.
  vi.spyOn(Redis.prototype, 'sendCommand').mockReturnValue(undefined);

  return client;
}

function setCapturing(client: CaptureValkey, value: boolean): void {
  (client as unknown as { capturing: boolean }).capturing = value;
}

function getBuffer(client: CaptureValkey): CapturedCommand[] {
  return (client as unknown as { buffer: CapturedCommand[] }).buffer;
}

function cmd(name: string, args: string[]): Command {
  return new Command(name, args);
}

describe('CaptureValkey', () => {
  beforeEach(() => {
    fetchCalls = [];
    fetchShouldFail = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('creates with a connectionId', () => {
    const client = makeClient();
    expect(client.connectionId).toBeTruthy();
    expect(typeof client.connectionId).toBe('string');
    void client.destroyCapture();
  });

  it('records a single command when capturing is on', () => {
    const client = makeClient();
    setCapturing(client, true);

    client.sendCommand(cmd('SET', ['key1', 'value1']));

    const s = client.stats();
    expect(s.capturedCount).toBe(1);
    expect(s.buffered).toBe(1);

    const buf = getBuffer(client);
    expect(buf[0].name).toBe('SET');
    expect(buf[0].args).toEqual(['key1', 'value1']);
    expect(buf[0].connectionId).toBe(client.connectionId);
    expect(buf[0].ts).toBeGreaterThan(0);
    void client.destroyCapture();
  });

  it('does not record when capturing is off', () => {
    const client = makeClient();

    client.sendCommand(cmd('GET', ['key1']));

    expect(client.stats().capturedCount).toBe(0);
    expect(client.stats().buffered).toBe(0);
    void client.destroyCapture();
  });

  it('drops with droppedCount when buffer is full', () => {
    const client = makeClient({ maxBufferedCommands: 3 });
    setCapturing(client, true);

    for (let i = 0; i < 5; i++) {
      client.sendCommand(cmd('PING', []));
    }

    const s = client.stats();
    expect(s.capturedCount).toBe(3);
    expect(s.droppedCount).toBe(2);
    expect(s.buffered).toBe(3);
    void client.destroyCapture();
  });

  it('flushes when buffer reaches batchSize', async () => {
    const client = makeClient({ batchSize: 3 });
    setCapturing(client, true);

    for (let i = 0; i < 3; i++) {
      client.sendCommand(cmd('INCR', [`counter${i}`]));
    }

    await vi.advanceTimersByTimeAsync(0);

    const batchPost = fetchCalls.find((c) => c.url.includes('/api/capture/instance/test-instance-1/batch'));
    expect(batchPost).toBeTruthy();
    const body = JSON.parse(batchPost!.body);
    expect(body.commands).toHaveLength(3);
    expect(body.connectionId).toBe(client.connectionId);
    expect(batchPost!.headers['Authorization']).toBe('Bearer test-token');
    void client.destroyCapture();
  });

  it('does not throw into caller when capture logic errors', () => {
    const client = makeClient();
    setCapturing(client, true);

    // Sabotage the buffer to cause an internal error
    (client as unknown as { buffer: unknown }).buffer = null;

    // sendCommand should NOT throw from capture — iovalkey errors are separate
    expect(() => {
      client.sendCommand(cmd('SET', ['a', 'b']));
    }).not.toThrow();

    // Restore buffer so stats() works
    (client as unknown as { buffer: CapturedCommand[] }).buffer = [];
    expect(client.stats().errorCount).toBe(1);
    void client.destroyCapture();
  });

  it('increments failedFlushCount on POST failure', async () => {
    fetchShouldFail = true;
    const client = makeClient({ batchSize: 1 });
    setCapturing(client, true);

    client.sendCommand(cmd('SET', ['x', 'y']));

    await vi.advanceTimersByTimeAsync(0);
    expect(client.stats().failedFlushCount).toBe(1);
    void client.destroyCapture();
  });

  it('pipeline commands are captured via sendCommand override', () => {
    const client = makeClient();
    setCapturing(client, true);

    client.sendCommand(cmd('SET', ['a', '1']));
    client.sendCommand(cmd('SET', ['b', '2']));
    client.sendCommand(cmd('GET', ['a']));

    expect(client.stats().capturedCount).toBe(3);
    const buf = getBuffer(client);
    expect(buf.map((r) => r.name)).toEqual(['SET', 'SET', 'GET']);
    void client.destroyCapture();
  });

  it('stats() returns correct shape', () => {
    const client = makeClient();
    const s = client.stats();
    expect(s).toEqual({
      capturedCount: 0,
      droppedCount: 0,
      failedFlushCount: 0,
      errorCount: 0,
      buffered: 0,
    });
    void client.destroyCapture();
  });
});
