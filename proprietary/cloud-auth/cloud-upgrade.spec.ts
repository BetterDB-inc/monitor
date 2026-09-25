import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import * as jwt from 'jsonwebtoken';
import type { ActorResolver } from '@app/auth/actor-resolver';
import { CliGateway } from '@app/cli/cli.gateway';
import type { CliService } from '@app/cli/cli.service';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import type { MonitorCaptureService } from '@app/monitor/monitor-capture.service';
import { TailGateway } from '@app/monitor/tail.gateway';
import { CloudActorResolver } from './cloud-actor-resolver';

const SECRET = 'cloud-session-secret';
const TOUCHED = ['SESSION_SECRET', 'DB_SCHEMA', 'DEMO_HOSTNAME'];
const HOST = 'acme-co.betterdb.com';
const TAIL_PATH = '/monitor/ws?sessionId=11111111-2222-3333-4444-555555555555';

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
  close(): void {
    this.readyState = 3;
  }
}

function sessionCookie(role: string): string {
  const token = jwt.sign(
    { userId: 'u1', email: 'm@example.com', role, subdomain: 'acme-co' },
    SECRET,
    { algorithm: 'HS256' },
  );
  return `betterdb_session=${token}`;
}

function upgradeRequest(url: string, cookie?: string): IncomingMessage {
  return {
    url,
    headers: { host: HOST, cookie },
    socket: { remoteAddress: '10.0.0.5' },
  } as unknown as IncomingMessage;
}

function cloudResolver(): ActorResolver {
  return new CloudActorResolver() as unknown as ActorResolver;
}

function stubHandshake(gateway: CliGateway | TailGateway): jest.Mock {
  const wss = (gateway as unknown as { wss: { handleUpgrade: jest.Mock } }).wss;
  wss.handleUpgrade = jest.fn();
  return wss.handleUpgrade;
}

function tailGateway(): TailGateway {
  return new TailGateway({} as MonitorCaptureService, {} as StoragePort, cloudResolver());
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('cloud WebSocket upgrades', () => {
  const previous = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of TOUCHED) {
      previous.set(key, process.env[key]);
    }
    process.env.SESSION_SECRET = SECRET;
    process.env.DB_SCHEMA = 'tenant_acme_co';
    delete process.env.DEMO_HOSTNAME;
  });

  afterEach(() => {
    for (const key of TOUCHED) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('refuses a CLI upgrade without a session cookie with HTTP 401', async () => {
    const gateway = new CliGateway({} as CliService, cloudResolver());
    const handshake = stubHandshake(gateway);
    const socket = new FakeSocket();
    gateway.handleUpgrade(upgradeRequest('/cli/ws'), socket as unknown as Socket, Buffer.alloc(0));
    await flush();
    expect(socket.written[0].startsWith('HTTP/1.1 401 Unauthorized')).toBe(true);
    expect(socket.destroyed).toBe(true);
    expect(handshake).not.toHaveBeenCalled();
  });

  it('accepts a CLI upgrade that carries a valid cloud session', async () => {
    const gateway = new CliGateway({} as CliService, cloudResolver());
    const handshake = stubHandshake(gateway);
    const socket = new FakeSocket();
    gateway.handleUpgrade(
      upgradeRequest('/cli/ws', sessionCookie('member')),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );
    await flush();
    expect(handshake).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(false);
  });

  it('refuses a monitor upgrade without a session cookie with HTTP 401', async () => {
    const gateway = tailGateway();
    const handshake = stubHandshake(gateway);
    const socket = new FakeSocket();
    gateway.handleUpgrade(upgradeRequest(TAIL_PATH), socket as unknown as Socket, Buffer.alloc(0));
    await flush();
    expect(socket.written[0].startsWith('HTTP/1.1 401 Unauthorized')).toBe(true);
    expect(socket.destroyed).toBe(true);
    expect(handshake).not.toHaveBeenCalled();
  });

  it('accepts a monitor upgrade that carries a valid cloud session', async () => {
    const gateway = tailGateway();
    const handshake = stubHandshake(gateway);
    const socket = new FakeSocket();
    gateway.handleUpgrade(
      upgradeRequest(TAIL_PATH, sessionCookie('member')),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );
    await flush();
    expect(handshake).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(false);
  });

  it('runs CLI commands for a cloud member without the read-only restriction', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue({ type: 'result', result: 'OK', resultType: 'string', durationMs: 1 });
    const gateway = new CliGateway({ execute } as unknown as CliService, cloudResolver());
    const ws = new FakeWebSocket();
    (gateway as unknown as { attach: (ws: unknown, request: IncomingMessage) => void }).attach(
      ws,
      upgradeRequest('/cli/ws', sessionCookie('member')),
    );
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'execute', command: 'SET a b', connectionId: 'c1' })),
    );
    await flush();
    expect(execute).toHaveBeenCalledWith('SET a b', 'c1', { readOnly: false });
  });
});
