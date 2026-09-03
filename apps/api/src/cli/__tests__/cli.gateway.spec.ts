import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import { Actor } from '@betterdb/shared';
import { ActorResolver } from '../../auth/actor-resolver';
import { CliGateway } from '../cli.gateway';
import { CliService, MEMBER_READ_ONLY_MESSAGE } from '../cli.service';

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
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
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
    resolveFromHeaders: jest.fn().mockResolvedValue(actor),
  } as unknown as ActorResolver;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('CliGateway.handleUpgrade', () => {
  it('passes through without resolving when the workspace is disabled', async () => {
    const resolver = resolverWith(false, null);
    const gateway = new CliGateway({} as CliService, resolver);
    const wss = (gateway as unknown as { wss: { handleUpgrade: jest.Mock } }).wss;
    wss.handleUpgrade = jest.fn();
    const socket = new FakeSocket();
    gateway.handleUpgrade(makeRequest(), socket as unknown as Socket, Buffer.alloc(0));
    await flush();
    expect(resolver.resolveFromHeaders).not.toHaveBeenCalled();
    expect(wss.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(false);
  });

  it('rejects the upgrade with HTTP 401 when enabled and no session resolves', async () => {
    const gateway = new CliGateway({} as CliService, resolverWith(true, null));
    const wss = (gateway as unknown as { wss: { handleUpgrade: jest.Mock } }).wss;
    wss.handleUpgrade = jest.fn();
    const socket = new FakeSocket();
    gateway.handleUpgrade(makeRequest(), socket as unknown as Socket, Buffer.alloc(0));
    await flush();
    expect(socket.written[0].startsWith('HTTP/1.1 401 Unauthorized')).toBe(true);
    expect(socket.destroyed).toBe(true);
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('completes the handshake when a session resolves and passes the socket address as client ip', async () => {
    const resolver = resolverWith(true, admin);
    const gateway = new CliGateway({} as CliService, resolver);
    const wss = (gateway as unknown as { wss: { handleUpgrade: jest.Mock } }).wss;
    wss.handleUpgrade = jest.fn();
    const socket = new FakeSocket();
    gateway.handleUpgrade(makeRequest('c=1'), socket as unknown as Socket, Buffer.alloc(0));
    await flush();
    expect(resolver.resolveFromHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ cookie: 'c=1' }),
      '10.0.0.5',
    );
    expect(wss.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(false);
  });
});

describe('CliGateway command execution', () => {
  function connect(gateway: CliGateway, actor: Actor | null): FakeWebSocket {
    const ws = new FakeWebSocket();
    (gateway as unknown as { attach: (ws: unknown, actor: Actor | null) => void }).attach(
      ws,
      actor,
    );
    return ws;
  }

  it('executes member commands in read-only mode', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue({ type: 'result', result: 'PONG', resultType: 'string', durationMs: 1 });
    const gateway = new CliGateway(
      { execute } as unknown as CliService,
      resolverWith(true, member),
    );
    const ws = connect(gateway, member);
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'execute', command: 'SET a b', connectionId: 'c1' })),
    );
    await flush();
    expect(execute).toHaveBeenCalledWith('SET a b', 'c1', { readOnly: true });
  });

  it('executes admin commands without the read-only flag', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue({ type: 'result', result: 'PONG', resultType: 'string', durationMs: 1 });
    const gateway = new CliGateway({ execute } as unknown as CliService, resolverWith(true, admin));
    const ws = connect(gateway, admin);
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'execute', command: 'SET a b', connectionId: 'c1' })),
    );
    await flush();
    expect(execute).toHaveBeenCalledWith('SET a b', 'c1', { readOnly: false });
  });
});

describe('MEMBER_READ_ONLY_MESSAGE', () => {
  it('is the message members see', () => {
    expect(MEMBER_READ_ONLY_MESSAGE).toBe('Read-only members can only run read commands.');
  });
});
