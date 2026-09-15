import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import type { WebSocket } from 'ws';
import { Actor } from '@betterdb/shared';
import { ActorResolver } from '../../auth/actor-resolver';
import type { ActivityService } from '../../activity/activity.service';
import { CliGateway, SESSION_EXPIRED_MESSAGE } from '../cli.gateway';
import { CliService } from '../cli.service';

function activityWith(): { service: ActivityService; record: jest.Mock } {
  const record = jest.fn().mockResolvedValue(undefined);
  return { service: { record } as unknown as ActivityService, record };
}

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

function makeRequest(cookie?: string, forwardedFor?: string): IncomingMessage {
  return {
    url: '/cli/ws',
    headers: { host: 'localhost', cookie, 'x-forwarded-for': forwardedFor },
    socket: { remoteAddress: '10.0.0.5' },
  } as unknown as IncomingMessage;
}

function resolverWith(
  enabled: boolean,
  actor: Actor | null,
  enforcesMemberReadOnly = true,
): ActorResolver {
  return {
    isEnabled: () => {
      return enabled;
    },
    isReady: () => {
      return true;
    },
    enforcesMemberReadOnly: () => {
      return enforcesMemberReadOnly;
    },
    resolveFromUpgrade: jest.fn().mockResolvedValue(actor),
  } as unknown as ActorResolver;
}

function restoreTrustProxyEnv(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.TRUST_PROXY;
    return;
  }
  process.env.TRUST_PROXY = value;
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

describe('CliGateway command execution', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function accessOf(gateway: CliGateway, ws: FakeWebSocket): Promise<unknown> {
    return (
      gateway as unknown as { resolveAccess: (ws: unknown) => Promise<unknown> }
    ).resolveAccess(ws);
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

  it('executes member commands unrestricted when the resolver does not enforce read-only', async () => {
    const execute = executeMock();
    const gateway = new CliGateway(
      { execute } as unknown as CliService,
      resolverWith(true, member, false),
    );
    const ws = connect(gateway);
    sendExecute(ws);
    await flush();
    expect(execute).toHaveBeenCalledWith('SET a b', 'c1', { readOnly: false });
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

  it('resolves the session once for commands within 30 seconds of each other', async () => {
    const execute = executeMock();
    const resolver = resolverWith(true, admin);
    const gateway = new CliGateway({ execute } as unknown as CliService, resolver);
    const request = makeRequest('c=1');
    const ws = connect(gateway, request);
    sendExecute(ws);
    await flush();
    jest.advanceTimersByTime(29_999);
    sendExecute(ws);
    await flush();
    expect(resolver.resolveFromUpgrade).toHaveBeenCalledTimes(1);
    expect(resolver.resolveFromUpgrade).toHaveBeenCalledWith(request);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('resolves the session again once 30 seconds have passed', async () => {
    const execute = executeMock();
    const resolver = resolverWith(true, admin);
    const gateway = new CliGateway({ execute } as unknown as CliService, resolver);
    const ws = connect(gateway);
    sendExecute(ws);
    await flush();
    jest.advanceTimersByTime(30_000);
    sendExecute(ws);
    await flush();
    expect(resolver.resolveFromUpgrade).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed session resolve', async () => {
    const resolver = resolverWith(true, admin);
    (resolver.resolveFromUpgrade as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(admin);
    const gateway = new CliGateway({} as CliService, resolver);
    const ws = connect(gateway);
    await expect(accessOf(gateway, ws)).resolves.toEqual({
      sessionValid: false,
      readOnly: true,
      actor: null,
      ip: '10.0.0.5',
    });
    await expect(accessOf(gateway, ws)).resolves.toEqual({
      sessionValid: true,
      readOnly: false,
      actor: admin,
      ip: '10.0.0.5',
    });
    expect(resolver.resolveFromUpgrade).toHaveBeenCalledTimes(2);
  });

  it('carries the resolved actor in the cached access', async () => {
    const resolver = resolverWith(true, member);
    const gateway = new CliGateway({} as CliService, resolver);
    const ws = connect(gateway);
    await accessOf(gateway, ws);
    await expect(accessOf(gateway, ws)).resolves.toEqual({
      sessionValid: true,
      readOnly: true,
      actor: member,
      ip: '10.0.0.5',
    });
    expect(resolver.resolveFromUpgrade).toHaveBeenCalledTimes(1);
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
    jest.advanceTimersByTime(30_000);
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
    expect(access).toEqual({ sessionValid: true, readOnly: true, actor: null, ip: '' });
  });
});

describe('CliGateway activity recording', () => {
  function send(ws: FakeWebSocket, command: string): void {
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'execute', command, connectionId: 'c1' })),
    );
  }

  it('records nothing while workspace auth is off and no actor is identified', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue({ type: 'result', result: 'b', resultType: 'string', durationMs: 1 });
    const activity = activityWith();
    const gateway = new CliGateway(
      { execute } as unknown as CliService,
      resolverWith(false, null),
      activity.service,
    );
    const ws = connect(gateway);
    send(ws, 'GET a');
    await flush();
    expect(execute).toHaveBeenCalledWith('GET a', 'c1', { readOnly: false });
    expect(activity.record).not.toHaveBeenCalled();
  });

  it('records read commands with their arguments', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue({ type: 'result', result: 'b', resultType: 'string', durationMs: 1 });
    const activity = activityWith();
    const gateway = new CliGateway(
      { execute } as unknown as CliService,
      resolverWith(true, admin),
      activity.service,
    );
    const ws = connect(gateway);
    send(ws, 'GET a');
    await flush();
    expect(activity.record).toHaveBeenCalledWith({
      actor: { userId: 'a', email: 'a@x', via: 'cli', tokenId: null },
      action: 'cli.command',
      statusCode: 200,
      ip: '10.0.0.5',
      connectionId: 'c1',
      details: { command: 'GET', argCount: 1, args: ['a'] },
    });
  });

  it('records write commands without argument values', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue({ type: 'result', result: 'OK', resultType: 'string', durationMs: 1 });
    const activity = activityWith();
    const gateway = new CliGateway(
      { execute } as unknown as CliService,
      resolverWith(true, admin),
      activity.service,
    );
    const ws = connect(gateway);
    send(ws, 'SET secret "p@ss word"');
    await flush();
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ details: { command: 'SET', argCount: 2 } }),
    );
    const [call] = activity.record.mock.calls;
    expect(JSON.stringify(call[0])).not.toContain('p@ss');
  });

  it('records a refused or failed command with status 400', async () => {
    const execute = jest.fn().mockResolvedValue({ type: 'error', error: 'nope' });
    const activity = activityWith();
    const gateway = new CliGateway(
      { execute } as unknown as CliService,
      resolverWith(true, member),
      activity.service,
    );
    const ws = connect(gateway);
    send(ws, 'DEL secretkey');
    await flush();
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ userId: 'm', via: 'cli' }),
        statusCode: 400,
        details: { command: 'DEL', argCount: 1 },
      }),
    );
  });

  it('never stores AUTH, HELLO, CONFIG, ACL or MIGRATE arguments', async () => {
    const execute = jest.fn().mockResolvedValue({ type: 'error', error: 'nope' });
    const activity = activityWith();
    const gateway = new CliGateway(
      { execute } as unknown as CliService,
      resolverWith(true, member),
      activity.service,
    );
    const ws = connect(gateway);
    send(ws, 'AUTH hunter2');
    await flush();
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ details: { command: 'AUTH', argCount: 1 } }),
    );
    expect(JSON.stringify(activity.record.mock.calls[0][0])).not.toContain('hunter2');

    send(ws, 'CONFIG SET requirepass hunter2');
    await flush();
    const configCall = activity.record.mock.calls[1][0];
    expect(configCall).toEqual(
      expect.objectContaining({ details: { command: 'CONFIG', argCount: 3 } }),
    );
    expect(JSON.stringify(configCall)).not.toContain('hunter2');

    send(ws, 'ACL SETUSER alice on >hunter2 ~* +@all');
    await flush();
    const aclCall = activity.record.mock.calls[2][0];
    expect(aclCall).toEqual(expect.objectContaining({ details: { command: 'ACL', argCount: 6 } }));
    expect(JSON.stringify(aclCall)).not.toContain('hunter2');
  });

  it('keeps arguments for a non-secret container read', async () => {
    const execute = jest.fn().mockResolvedValue({ type: 'error', error: 'nope' });
    const activity = activityWith();
    const gateway = new CliGateway(
      { execute } as unknown as CliService,
      resolverWith(true, member),
      activity.service,
    );
    const ws = connect(gateway);
    send(ws, 'CLIENT LIST');
    await flush();
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        details: { command: 'CLIENT', argCount: 1, args: ['LIST'] },
      }),
    );
  });

  it('drops arguments for read commands that carry a caller-supplied body', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue({ type: 'result', result: '', resultType: 'string', durationMs: 1 });
    const activity = activityWith();
    const gateway = new CliGateway(
      { execute } as unknown as CliService,
      resolverWith(true, admin),
      activity.service,
    );
    const ws = connect(gateway);
    const payloads = [
      'PUBLISH alerts hunter2',
      'SPUBLISH alerts hunter2',
      'ECHO hunter2',
      "EVAL_RO 'return hunter2' 0",
      'EVALSHA_RO abc123 0 hunter2',
      'FCALL_RO fn 0 hunter2',
      'COMMAND GETKEYS SET k hunter2',
      'PING hunter2',
      'COMMAND GETKEYSANDFLAGS AUTH admin hunter2',
    ];
    for (const command of payloads) {
      send(ws, command);
      await flush();
    }
    expect(activity.record).toHaveBeenCalledTimes(payloads.length);
    for (const [call] of activity.record.mock.calls) {
      expect(call.details).not.toHaveProperty('args');
      expect(JSON.stringify(call)).not.toContain('hunter2');
    }
  });

  it('records a command that returns an error result as a failure', async () => {
    const execute = jest.fn().mockResolvedValue({
      type: 'result',
      result: 'ERR timeout',
      resultType: 'error',
      durationMs: 1,
    });
    const activity = activityWith();
    const gateway = new CliGateway(
      { execute } as unknown as CliService,
      resolverWith(true, admin),
      activity.service,
    );
    const ws = connect(gateway);
    send(ws, 'GET a');
    await flush();
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('caps recorded arguments', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue({ type: 'result', result: '', resultType: 'string', durationMs: 1 });
    const activity = activityWith();
    const gateway = new CliGateway(
      { execute } as unknown as CliService,
      resolverWith(true, admin),
      activity.service,
    );
    const ws = connect(gateway);
    const longKey = 'k'.repeat(300);
    const keys = Array.from({ length: 20 }, (_, i) => {
      return i === 5 ? longKey : `key${i}`;
    });
    send(ws, `MGET ${keys.join(' ')}`);
    await flush();
    const [call] = activity.record.mock.calls;
    const details = call[0].details as { command: string; argCount: number; args: string[] };
    expect(details.args).toHaveLength(16);
    expect(details.args[5]).toHaveLength(128);
    expect(details.argCount).toBe(20);
  });

  it('records the command even when the socket closes before the result arrives', async () => {
    let resolveExecute: (value: {
      type: 'result';
      result: string;
      resultType: string;
      durationMs: number;
    }) => void = () => {};
    const execute = jest.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveExecute = resolve;
      }),
    );
    const activity = activityWith();
    const gateway = new CliGateway(
      { execute } as unknown as CliService,
      resolverWith(true, admin),
      activity.service,
    );
    const ws = connect(gateway);
    send(ws, 'GET a');
    await flush();
    ws.emit('close');
    resolveExecute({ type: 'result', result: 'b', resultType: 'string', durationMs: 1 });
    await flush();
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({
        ip: '10.0.0.5',
        details: { command: 'GET', argCount: 1, args: ['a'] },
      }),
    );
  });

  it('records the forwarded address when trust proxy is enabled', async () => {
    const originalTrustProxy = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = 'true';
    try {
      const execute = jest
        .fn()
        .mockResolvedValue({ type: 'result', result: 'PONG', resultType: 'string', durationMs: 1 });
      const activity = activityWith();
      const gateway = new CliGateway(
        { execute } as unknown as CliService,
        resolverWith(true, admin),
        activity.service,
      );
      const request = makeRequest('c=1', '203.0.113.9');
      const ws = connect(gateway, request);
      send(ws, 'PING');
      await flush();
      expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ ip: '203.0.113.9' }));
    } finally {
      restoreTrustProxyEnv(originalTrustProxy);
    }
  });

  it('records the socket address when trust proxy is disabled, even with a forwarded header', async () => {
    const originalTrustProxy = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;
    try {
      const execute = jest
        .fn()
        .mockResolvedValue({ type: 'result', result: 'PONG', resultType: 'string', durationMs: 1 });
      const activity = activityWith();
      const gateway = new CliGateway(
        { execute } as unknown as CliService,
        resolverWith(true, admin),
        activity.service,
      );
      const request = makeRequest('c=1', '203.0.113.9');
      const ws = connect(gateway, request);
      send(ws, 'PING');
      await flush();
      expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ ip: '10.0.0.5' }));
    } finally {
      restoreTrustProxyEnv(originalTrustProxy);
    }
  });

  it('records nothing when no actor resolves', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue({ type: 'result', result: 'PONG', resultType: 'string', durationMs: 1 });
    const activity = activityWith();
    const gateway = new CliGateway(
      { execute } as unknown as CliService,
      resolverWith(false, null),
      activity.service,
    );
    const ws = connect(gateway);
    send(ws, 'PING');
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(activity.record).not.toHaveBeenCalled();
  });
});
