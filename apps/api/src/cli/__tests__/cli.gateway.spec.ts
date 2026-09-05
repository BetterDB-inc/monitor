import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import type { WebSocket } from 'ws';
import { Actor } from '@betterdb/shared';
import { ActorResolver } from '../../auth/actor-resolver';
import { CliGateway, SESSION_EXPIRED_MESSAGE } from '../cli.gateway';
import { CliService } from '../cli.service';

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

class FakeWebSocket extends EventEmitter {
  sent: string[] = [];
  readyState = 1;
  closeCalls: Array<[number | undefined, string | undefined]> = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
  }
}

const member: Actor = {
  userId: 'm',
  email: 'm@x',
  role: 'member',
  isOwner: false,
  via: 'session',
  tokenId: null,
};
const admin: Actor = {
  userId: 'a',
  email: 'a@x',
  role: 'admin',
  isOwner: true,
  via: 'session',
  tokenId: null,
};

function makeRequest(cookie?: string): IncomingMessage {
  return {
    url: '/cli/ws',
    headers: { host: 'localhost', cookie },
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
    resolveFromUpgrade: jest.fn().mockResolvedValue(actor),
  } as unknown as ActorResolver;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function stubHandshake(gateway: CliGateway): jest.Mock {
  const wss = (gateway as unknown as { wss: { handleUpgrade: jest.Mock } }).wss;
  wss.handleUpgrade = jest.fn();
  return wss.handleUpgrade;
}

describe('CliGateway.handleUpgrade', () => {
  it('passes through without resolving when the workspace is disabled', async () => {
    const resolver = resolverWith(false, null);
    const gateway = new CliGateway({} as CliService, resolver);
    const handshake = stubHandshake(gateway);
    const socket = new FakeSocket();
    gateway.handleUpgrade(makeRequest(), socket as unknown as Socket, Buffer.alloc(0));
    await flush();
    expect(resolver.resolveFromUpgrade).not.toHaveBeenCalled();
    expect(handshake).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(false);
  });

  it('passes through when no resolver is provided at all', async () => {
    const gateway = new CliGateway({} as CliService, null);
    const handshake = stubHandshake(gateway);
    const socket = new FakeSocket();
    gateway.handleUpgrade(makeRequest(), socket as unknown as Socket, Buffer.alloc(0));
    await flush();
    expect(handshake).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(false);
  });

  it('rejects the upgrade with HTTP 401 when enabled and no session resolves', async () => {
    const gateway = new CliGateway({} as CliService, resolverWith(true, null));
    const handshake = stubHandshake(gateway);
    const socket = new FakeSocket();
    gateway.handleUpgrade(makeRequest(), socket as unknown as Socket, Buffer.alloc(0));
    await flush();
    expect(socket.written[0].startsWith('HTTP/1.1 401 Unauthorized')).toBe(true);
    expect(socket.destroyed).toBe(true);
    expect(handshake).not.toHaveBeenCalled();
  });

  it('completes the handshake when a session resolves', async () => {
    const resolver = resolverWith(true, admin);
    const gateway = new CliGateway({} as CliService, resolver);
    const handshake = stubHandshake(gateway);
    const socket = new FakeSocket();
    const request = makeRequest('c=1');
    gateway.handleUpgrade(request, socket as unknown as Socket, Buffer.alloc(0));
    await flush();
    expect(resolver.resolveFromUpgrade).toHaveBeenCalledWith(request);
    expect(handshake).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(false);
  });

  it('destroys the socket when the resolver throws during the upgrade', async () => {
    const resolver = resolverWith(true, admin);
    (resolver.resolveFromUpgrade as jest.Mock).mockRejectedValue(new Error('boom'));
    const gateway = new CliGateway({} as CliService, resolver);
    const handshake = stubHandshake(gateway);
    const socket = new FakeSocket();
    gateway.handleUpgrade(makeRequest(), socket as unknown as Socket, Buffer.alloc(0));
    await flush();
    expect(socket.destroyed).toBe(true);
    expect(handshake).not.toHaveBeenCalled();
  });

  it('destroys the socket on a socket error while the upgrade is pending', () => {
    const gateway = new CliGateway({} as CliService, resolverWith(true, admin));
    stubHandshake(gateway);
    const socket = new FakeSocket();
    gateway.handleUpgrade(makeRequest(), socket as unknown as Socket, Buffer.alloc(0));
    socket.emit('error', new Error('reset'));
    expect(socket.destroyed).toBe(true);
  });
});

describe('CliGateway command execution', () => {
  function connect(
    gateway: CliGateway,
    request: IncomingMessage = makeRequest('c=1'),
  ): FakeWebSocket {
    const ws = new FakeWebSocket();
    (gateway as unknown as { attach: (ws: unknown, request: IncomingMessage) => void }).attach(
      ws,
      request,
    );
    return ws;
  }

  function sendExecute(ws: FakeWebSocket): void {
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'execute', command: 'SET a b', connectionId: 'c1' })),
    );
  }

  function executeMock(): jest.Mock {
    return jest
      .fn()
      .mockResolvedValue({ type: 'result', result: 'PONG', resultType: 'string', durationMs: 1 });
  }

  it('executes member commands in read-only mode', async () => {
    const execute = executeMock();
    const gateway = new CliGateway(
      { execute } as unknown as CliService,
      resolverWith(true, member),
    );
    const ws = connect(gateway);
    sendExecute(ws);
    await flush();
    expect(execute).toHaveBeenCalledWith('SET a b', 'c1', { readOnly: true });
  });

  it('executes admin commands without the read-only flag', async () => {
    const execute = executeMock();
    const gateway = new CliGateway({ execute } as unknown as CliService, resolverWith(true, admin));
    const ws = connect(gateway);
    sendExecute(ws);
    await flush();
    expect(execute).toHaveBeenCalledWith('SET a b', 'c1', { readOnly: false });
  });

  it('runs commands unrestricted when the workspace is disabled', async () => {
    const execute = executeMock();
    const resolver = resolverWith(false, null);
    const gateway = new CliGateway({ execute } as unknown as CliService, resolver);
    const ws = connect(gateway);
    sendExecute(ws);
    await flush();
    expect(resolver.resolveFromUpgrade).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith('SET a b', 'c1', { readOnly: false });
  });

  it('re-resolves the session on every command using the upgrade request', async () => {
    const execute = executeMock();
    const resolver = resolverWith(true, admin);
    const gateway = new CliGateway({ execute } as unknown as CliService, resolver);
    const request = makeRequest('c=1');
    const ws = connect(gateway, request);
    sendExecute(ws);
    sendExecute(ws);
    await flush();
    expect(resolver.resolveFromUpgrade).toHaveBeenCalledTimes(2);
    expect(resolver.resolveFromUpgrade).toHaveBeenCalledWith(request);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('expires the socket instead of running the command when the session is gone', async () => {
    const execute = executeMock();
    const resolver = resolverWith(true, admin);
    (resolver.resolveFromUpgrade as jest.Mock).mockResolvedValueOnce(admin).mockResolvedValue(null);
    const gateway = new CliGateway({ execute } as unknown as CliService, resolver);
    const ws = connect(gateway);
    sendExecute(ws);
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    sendExecute(ws);
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws.sent[ws.sent.length - 1])).toEqual({
      type: 'error',
      error: SESSION_EXPIRED_MESSAGE,
    });
    expect(ws.closeCalls).toEqual([[4401, 'Session expired']]);
  });

  it('treats a socket without connection state as read-only', async () => {
    const gateway = new CliGateway({} as CliService, resolverWith(true, admin));
    const access = await (
      gateway as unknown as {
        resolveAccess: (ws: WebSocket) => Promise<{ sessionValid: boolean; readOnly: boolean }>;
      }
    ).resolveAccess(new FakeWebSocket() as unknown as WebSocket);
    expect(access).toEqual({ sessionValid: true, readOnly: true });
  });
});
