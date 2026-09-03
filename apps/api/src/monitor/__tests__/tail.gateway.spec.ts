import { EventEmitter } from 'events';
import type { Socket } from 'net';
import type { IncomingMessage } from 'http';
import { Actor } from '@betterdb/shared';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';
import type { ActorResolver } from '../../auth/actor-resolver';
import type { CaptureWriter } from '../capture-writer';
import type { MonitorCaptureService } from '../monitor-capture.service';
import { TailGateway } from '../tail.gateway';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

const admin: Actor = {
  userId: 'a',
  email: 'a@x',
  role: 'admin',
  isOwner: true,
  via: 'session',
  tokenId: null,
};

class FakeSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

function makeRequest(path: string, host = 'localhost'): IncomingMessage {
  return {
    url: path,
    headers: { host, cookie: undefined },
    socket: { remoteAddress: '10.0.0.5' },
  } as unknown as IncomingMessage;
}

function resolverWith(enabled: boolean, actor: Actor | null): ActorResolver {
  return {
    isEnabled: () => {
      return enabled;
    },
    isReady: () => {
      return true;
    },
    resolveFromHeaders: jest.fn().mockResolvedValue(actor),
  } as unknown as ActorResolver;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function makeGateway(actorResolver: ActorResolver = resolverWith(false, null)) {
  const captureService = {
    getSession: jest.fn(),
    getActiveWriter: jest.fn(),
  };
  const storage: Pick<StoragePort, 'getCaptureChunks'> = {
    getCaptureChunks: jest.fn().mockResolvedValue([]),
  };
  const gateway = new TailGateway(
    captureService as unknown as MonitorCaptureService,
    storage as StoragePort,
    actorResolver,
  );
  return { gateway, captureService, storage, actorResolver };
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('TailGateway.handleUpgrade', () => {
  it('destroys the socket when the demo host header matches DEMO_HOSTNAME', () => {
    process.env.DEMO_HOSTNAME = 'demo.local';
    const { gateway } = makeGateway();
    const socket = new FakeSocket();
    gateway.handleUpgrade(
      makeRequest(`/monitor/ws?sessionId=${SESSION_ID}`, 'demo.local'),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );
    expect(socket.destroyed).toBe(true);
  });

  it('passes through when host is non-demo even with DEMO_HOSTNAME set', () => {
    process.env.DEMO_HOSTNAME = 'demo.local';
    const { gateway } = makeGateway();
    // We can't easily exercise the real wss.handleUpgrade in a unit test, but
    // we can confirm the gate did NOT destroy the socket.
    const socket = new FakeSocket();
    // Stub the wss.handleUpgrade to capture the would-be connection
    const wss = (gateway as unknown as { wss: { handleUpgrade: jest.Mock } }).wss;
    wss.handleUpgrade = jest.fn();
    gateway.handleUpgrade(
      makeRequest(`/monitor/ws?sessionId=${SESSION_ID}`, 'app.local'),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );
    expect(socket.destroyed).toBe(false);
    expect(wss.handleUpgrade).toHaveBeenCalled();
  });

  it('destroys the socket when sessionId query param is missing', () => {
    const { gateway } = makeGateway();
    const socket = new FakeSocket();
    gateway.handleUpgrade(makeRequest('/monitor/ws'), socket as unknown as Socket, Buffer.alloc(0));
    expect(socket.destroyed).toBe(true);
  });

  it('passes through without resolving when the workspace is disabled', async () => {
    const resolver = resolverWith(false, null);
    const { gateway } = makeGateway(resolver);
    const wss = (gateway as unknown as { wss: { handleUpgrade: jest.Mock } }).wss;
    wss.handleUpgrade = jest.fn();
    const socket = new FakeSocket();
    gateway.handleUpgrade(
      makeRequest(`/monitor/ws?sessionId=${SESSION_ID}`),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );
    await flush();
    expect(resolver.resolveFromHeaders).not.toHaveBeenCalled();
    expect(wss.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(false);
  });

  it('rejects the upgrade with HTTP 401 when enabled and no session resolves', async () => {
    const { gateway } = makeGateway(resolverWith(true, null));
    const wss = (gateway as unknown as { wss: { handleUpgrade: jest.Mock } }).wss;
    wss.handleUpgrade = jest.fn();
    const socket = new FakeSocket();
    gateway.handleUpgrade(
      makeRequest(`/monitor/ws?sessionId=${SESSION_ID}`),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );
    await flush();
    expect(socket.written[0].startsWith('HTTP/1.1 401 Unauthorized')).toBe(true);
    expect(socket.destroyed).toBe(true);
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('completes the handshake when a session resolves', async () => {
    const { gateway } = makeGateway(resolverWith(true, admin));
    const wss = (gateway as unknown as { wss: { handleUpgrade: jest.Mock } }).wss;
    wss.handleUpgrade = jest.fn();
    const socket = new FakeSocket();
    gateway.handleUpgrade(
      makeRequest(`/monitor/ws?sessionId=${SESSION_ID}`),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );
    await flush();
    expect(wss.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Connection-handling tests use the private handleConnection method via cast,
// passing in a FakeWebSocket that records send/close calls.
// ---------------------------------------------------------------------------

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1; // OPEN
  sent: unknown[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.emit('close');
  }
}

interface PrivateGateway {
  handleConnection(ws: FakeWebSocket, sessionId: string): Promise<void>;
}

function asPrivate(g: TailGateway): PrivateGateway {
  return g as unknown as PrivateGateway;
}

function makeFakeWriter(opts: {
  ringBuffer?: string[];
  subscribe?: (cb: (line: string) => void) => () => void;
  onEnd?: (cb: () => void) => () => void;
}): CaptureWriter {
  const writer = {
    getRingBuffer: () => opts.ringBuffer ?? [],
    getCounters: () => ({ byteCount: 0, lineCount: 0 }),
    subscribe: opts.subscribe ?? jest.fn().mockReturnValue(() => undefined),
    onEnd: opts.onEnd ?? jest.fn().mockReturnValue(() => undefined),
  };
  return writer as unknown as CaptureWriter;
}

describe('TailGateway connection handling', () => {
  it('errors and closes when the session does not exist', async () => {
    const { gateway, captureService } = makeGateway();
    captureService.getSession.mockResolvedValue(null);

    const ws = new FakeWebSocket();
    await asPrivate(gateway).handleConnection(ws, SESSION_ID);

    expect(ws.sent).toEqual([{ type: 'error', error: `session ${SESSION_ID} not found` }]);
    expect(ws.closed).toBe(true);
  });

  describe('historical session', () => {
    it('streams persisted chunks line-by-line then closes', async () => {
      const { gateway, captureService, storage } = makeGateway();
      captureService.getSession.mockResolvedValue({
        id: SESSION_ID,
        connectionId: 'conn-1',
        status: 'completed',
      });
      captureService.getActiveWriter.mockReturnValue(undefined);
      (storage.getCaptureChunks as jest.Mock).mockResolvedValue([
        {
          sessionId: SESSION_ID,
          chunkIndex: 0,
          bytes: Buffer.from('one\ntwo'),
          lineCount: 2,
          firstTs: 0,
          lastTs: 1,
        },
        {
          sessionId: SESSION_ID,
          chunkIndex: 1,
          bytes: Buffer.from('three'),
          lineCount: 1,
          firstTs: 2,
          lastTs: 3,
        },
      ]);

      const ws = new FakeWebSocket();
      await asPrivate(gateway).handleConnection(ws, SESSION_ID);

      expect(ws.sent).toEqual([
        { type: 'line', line: 'one' },
        { type: 'line', line: 'two' },
        { type: 'line', line: 'three' },
        { type: 'status', status: 'historical_complete' },
      ]);
      expect(ws.closed).toBe(true);
    });
  });

  describe('live session', () => {
    it('sends the ring buffer backlog, then live lines, and closes on session end', async () => {
      const { gateway, captureService } = makeGateway();
      captureService.getSession.mockResolvedValue({
        id: SESSION_ID,
        connectionId: 'conn-1',
        status: 'running',
      });

      let lineSubscriber: ((l: string) => void) | null = null;
      let endSubscriber: (() => void) | null = null;
      const writer = makeFakeWriter({
        ringBuffer: ['old-1', 'old-2'],
        subscribe: (cb) => {
          lineSubscriber = cb;
          return () => undefined;
        },
        onEnd: (cb) => {
          endSubscriber = cb;
          return () => undefined;
        },
      });
      captureService.getActiveWriter.mockReturnValue(writer);

      const ws = new FakeWebSocket();
      await asPrivate(gateway).handleConnection(ws, SESSION_ID);

      // Backlog sent immediately
      expect(ws.sent).toEqual([
        { type: 'line', line: 'old-1' },
        { type: 'line', line: 'old-2' },
      ]);

      // Live line arrives
      lineSubscriber!('new-1');
      expect(ws.sent[ws.sent.length - 1]).toEqual({ type: 'line', line: 'new-1' });

      // Writer ends → status + close
      endSubscriber!();
      expect(ws.sent[ws.sent.length - 1]).toEqual({ type: 'status', status: 'session_ended' });
      expect(ws.closed).toBe(true);
    });

    it('buffers lines while paused and drains them on resume in original order', async () => {
      const { gateway, captureService } = makeGateway();
      captureService.getSession.mockResolvedValue({
        id: SESSION_ID,
        connectionId: 'conn-1',
        status: 'running',
      });

      let lineSubscriber: ((l: string) => void) | null = null;
      const writer = makeFakeWriter({
        ringBuffer: [],
        subscribe: (cb) => {
          lineSubscriber = cb;
          return () => undefined;
        },
      });
      captureService.getActiveWriter.mockReturnValue(writer);

      const ws = new FakeWebSocket();
      await asPrivate(gateway).handleConnection(ws, SESSION_ID);

      ws.emit('message', JSON.stringify({ type: 'pause' }));
      lineSubscriber!('paused-1');
      lineSubscriber!('paused-2');

      // Nothing delivered while paused
      expect(ws.sent).toEqual([]);

      ws.emit('message', JSON.stringify({ type: 'resume' }));

      expect(ws.sent).toEqual([
        { type: 'line', line: 'paused-1' },
        { type: 'line', line: 'paused-2' },
      ]);
    });

    it('unsubscribes on socket close so the writer is not held alive', async () => {
      const { gateway, captureService } = makeGateway();
      captureService.getSession.mockResolvedValue({
        id: SESSION_ID,
        connectionId: 'conn-1',
        status: 'running',
      });

      const unsubscribeLine = jest.fn();
      const unsubscribeEnd = jest.fn();
      const writer = makeFakeWriter({
        subscribe: () => unsubscribeLine,
        onEnd: () => unsubscribeEnd,
      });
      captureService.getActiveWriter.mockReturnValue(writer);

      const ws = new FakeWebSocket();
      await asPrivate(gateway).handleConnection(ws, SESSION_ID);
      ws.close();

      expect(unsubscribeLine).toHaveBeenCalled();
      expect(unsubscribeEnd).toHaveBeenCalled();
    });

    it('reports an error on invalid JSON control messages', async () => {
      const { gateway, captureService } = makeGateway();
      captureService.getSession.mockResolvedValue({
        id: SESSION_ID,
        connectionId: 'conn-1',
        status: 'running',
      });
      const writer = makeFakeWriter({});
      captureService.getActiveWriter.mockReturnValue(writer);

      const ws = new FakeWebSocket();
      await asPrivate(gateway).handleConnection(ws, SESSION_ID);
      ws.emit('message', 'not-json');

      expect(ws.sent.find((m) => (m as { type: string }).type === 'error')).toEqual({
        type: 'error',
        error: 'invalid JSON control message',
      });
    });
  });
});
