import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import {
  SshTunnelService,
  SSH_KEY_DIR_ENV,
  hostKeyMatchesFingerprint,
} from '../ssh-tunnel.service';
import {
  DEFAULT_REDIS_PORT,
  MOCK_TUNNEL_PORT,
  SSH_DEFAULT_PORT,
  SSH_MAX_HOPS,
  SSH_MAX_NODE_FORWARDS,
  SSH_NODE_FORWARD_TIMEOUT_MS,
} from '@betterdb/shared';

// --- ssh2 mock -------------------------------------------------------------

const FAKE_HOST_KEY = Buffer.from('FAKE-HOST-KEY');

// When true, the pre-flight forwardOut never invokes its callback, simulating
// a tunnel whose setup stalls so a mid-setup SSH drop can be exercised.
let preflightHangs = false;

class MockSshClient extends EventEmitter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connect = jest.fn((opts?: any) => {
    // Mimic ssh2 invoking the host verifier during the handshake.
    if (opts && typeof opts.hostVerifier === 'function') {
      if (!opts.hostVerifier(FAKE_HOST_KEY)) {
        setImmediate(() => this.emit('error', new Error('handshake failed')));
        return;
      }
    }
    // Emit ready asynchronously to mimic a successful handshake.
    setImmediate(() => this.emit('ready'));
  });
  forwardOut = jest.fn(
    (
      _srcIp: string,
      _srcPort: number,
      _dstHost: string,
      _dstPort: number,
      cb: (err: Error | undefined, stream: unknown) => void,
    ) => {
      if (preflightHangs) {
        return; // never calls back — setup stalls
      }
      const stream = { end: jest.fn(), pipe: jest.fn(), on: jest.fn(), destroy: jest.fn() };
      cb(undefined, stream);
    },
  );
  end = jest.fn();
}

let lastClient: MockSshClient;
jest.mock('ssh2', () => ({
  Client: jest.fn().mockImplementation(() => {
    lastClient = new MockSshClient();
    return lastClient;
  }),
}));

// --- net mock: server binds an ephemeral port ------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastServer: any;
// When true, server.listen never invokes its callback, so setup stalls at the
// listen stage (after the server is created) — used to exercise abort cleanup.
let listenHangs = false;
jest.mock('net', () => {
  const actual = jest.requireActual('events');
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createServer: jest.fn((connectionHandler: (socket: any) => void) => {
      const server = new actual.EventEmitter();
      server.connectionHandler = connectionHandler;
      server.listen = jest.fn((_port: number, _host: string, cb: () => void) => {
        if (listenHangs) {
          return;
        }
        setImmediate(cb);
      });
      server.address = jest.fn(() => ({ port: MOCK_TUNNEL_PORT }));
      server.close = jest.fn((cb?: () => void) => {
        if (cb) cb();
      });
      lastServer = server;
      return server;
    }),
  };
});

// --- fs mock for file-based keys -------------------------------------------

jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  readFileSync: jest.fn(() => Buffer.from('FILE-KEY-CONTENT')),
  // Identity realpath by default (no symlinks); individual tests override.
  realpathSync: jest.fn((p: string) => p),
}));

import * as fs from 'fs';

describe('SshTunnelService', () => {
  let service: SshTunnelService;

  beforeEach(() => {
    jest.clearAllMocks();
    preflightHangs = false;
    listenHangs = false;
    delete process.env[SSH_KEY_DIR_ENV];
    service = new SshTunnelService();
  });

  it('creates a password-auth tunnel and returns the local port', async () => {
    const port = await service.createTunnel('c1', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });

    expect(port).toBe(MOCK_TUNNEL_PORT);
    expect(service.hasTunnel('c1')).toBe(true);
    expect(lastClient.connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'bastion', port: 22, username: 'user', password: 'secret' }),
    );
  });

  it('creates a tunnel with an inline private key', async () => {
    const port = await service.createTunnel('c2', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'privateKey',
      keySource: 'inline',
      privateKey: '-----BEGIN KEY-----',
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });

    expect(port).toBe(MOCK_TUNNEL_PORT);
    const connectArg = (lastClient.connect.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(connectArg.privateKey).toEqual(Buffer.from('-----BEGIN KEY-----'));
  });

  it('rejects a file-based key when BETTERDB_SSH_KEY_DIR is unset', async () => {
    await expect(
      service.createTunnel('c3', {
        sshHost: 'bastion',
        sshPort: SSH_DEFAULT_PORT,
        sshUsername: 'user',
        authMethod: 'privateKey',
        keySource: 'file',
        privateKeyPath: 'id_ed25519',
        remoteHost: 'db.internal',
        remotePort: DEFAULT_REDIS_PORT,
      }),
    ).rejects.toThrow(new RegExp(SSH_KEY_DIR_ENV));
    expect(service.hasTunnel('c3')).toBe(false);
  });

  it('reads a file-based key from inside BETTERDB_SSH_KEY_DIR', async () => {
    process.env[SSH_KEY_DIR_ENV] = '/keys';
    const port = await service.createTunnel('c4', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'privateKey',
      keySource: 'file',
      privateKeyPath: 'id_ed25519',
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });

    expect(port).toBe(MOCK_TUNNEL_PORT);
    expect(fs.readFileSync).toHaveBeenCalledWith('/keys/id_ed25519');
    const connectArg = (lastClient.connect.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(connectArg.privateKey).toEqual(Buffer.from('FILE-KEY-CONTENT'));
  });

  it('blocks path traversal outside BETTERDB_SSH_KEY_DIR', async () => {
    process.env[SSH_KEY_DIR_ENV] = '/keys';
    await expect(
      service.createTunnel('c5', {
        sshHost: 'bastion',
        sshPort: SSH_DEFAULT_PORT,
        sshUsername: 'user',
        authMethod: 'privateKey',
        keySource: 'file',
        privateKeyPath: '../../etc/shadow',
        remoteHost: 'db.internal',
        remotePort: DEFAULT_REDIS_PORT,
      }),
    ).rejects.toThrow(/must resolve inside/);
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('closes a tunnel and forgets it', async () => {
    await service.createTunnel('c6', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });
    await service.closeTunnel('c6');
    expect(service.hasTunnel('c6')).toBe(false);
    expect(lastClient.end).toHaveBeenCalled();
  });

  it('closeTunnel is a no-op for an unknown id', async () => {
    await expect(service.closeTunnel('nope')).resolves.toBeUndefined();
  });

  it('accepts the server when the pinned host-key fingerprint matches', async () => {
    const fingerprint =
      'SHA256:' + createHash('sha256').update(FAKE_HOST_KEY).digest('base64').replace(/=+$/, '');
    const port = await service.createTunnel('c7', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      hostKeyFingerprint: fingerprint,
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });
    expect(port).toBe(MOCK_TUNNEL_PORT);
  });

  it('rejects the server when the pinned host-key fingerprint does not match', async () => {
    await expect(
      service.createTunnel('c8', {
        sshHost: 'bastion',
        sshPort: SSH_DEFAULT_PORT,
        sshUsername: 'user',
        authMethod: 'password',
        password: 'secret',
        hostKeyFingerprint: 'SHA256:definitelywrongfingerprint',
        remoteHost: 'db.internal',
        remotePort: DEFAULT_REDIS_PORT,
      }),
    ).rejects.toThrow(/host-key verification failed/);
    expect(service.hasTunnel('c8')).toBe(false);
  });

  it('destroys live forwarded sockets on closeTunnel so server.close settles', async () => {
    await service.createTunnel('c9', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });

    // Simulate an accepted client socket flowing through the tunnel.
    const socket = new EventEmitter() as EventEmitter & { destroy: jest.Mock; pipe: jest.Mock };
    socket.destroy = jest.fn();
    socket.pipe = jest.fn();
    lastServer.connectionHandler(socket);

    await service.closeTunnel('c9');
    expect(socket.destroy).toHaveBeenCalled();
    expect(lastServer.close).toHaveBeenCalled();
  });

  it('does not crash when a forwarded socket errors on the forwarding-failure path', async () => {
    await service.createTunnel('c10', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });
    // Now make the per-socket forward fail (pre-flight already succeeded).
    lastClient.forwardOut = jest.fn((_i, _p, _h, _pt, cb) => {
      cb(new Error('channel open failed'), undefined as unknown as never);
    });

    const socket = new EventEmitter() as EventEmitter & { destroy: jest.Mock; pipe: jest.Mock };
    socket.destroy = jest.fn();
    socket.pipe = jest.fn();
    // Must not throw or emit an unhandled 'error' (which would crash the process
    // via the global uncaughtException handler).
    expect(() => lastServer.connectionHandler(socket)).not.toThrow();
    expect(socket.destroy).toHaveBeenCalledWith(); // destroyed with no error arg
  });

  it('learns the host key (TOFU) when no fingerprint is pinned', async () => {
    const onHostKey = jest.fn();
    await service.createTunnel('c11', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      onHostKey,
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });
    const expected =
      'SHA256:' + createHash('sha256').update(FAKE_HOST_KEY).digest('base64').replace(/=+$/, '');
    expect(onHostKey).toHaveBeenCalledWith(expected);
  });

  it('sets tryKeyboard for password auth so PAM bastions work', async () => {
    await service.createTunnel('c12', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });
    const opts = (lastClient.connect.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(opts.tryKeyboard).toBe(true);
  });

  it('signals onUnexpectedClose when an established tunnel drops', async () => {
    const onUnexpectedClose = jest.fn();
    await service.createTunnel('c13', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      onUnexpectedClose,
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });
    lastClient.emit('close');
    expect(onUnexpectedClose).toHaveBeenCalled();
    expect(service.hasTunnel('c13')).toBe(false);
  });

  it('does not signal onUnexpectedClose after an explicit closeTunnel', async () => {
    const onUnexpectedClose = jest.fn();
    await service.createTunnel('c14', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      onUnexpectedClose,
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });
    await service.closeTunnel('c14');
    lastClient.emit('close'); // late close event from the ended client
    expect(onUnexpectedClose).not.toHaveBeenCalled();
  });

  it('aborts createTunnel when the SSH session drops mid-setup (B)', async () => {
    preflightHangs = true; // stall in the pre-flight so setup is in flight
    const promise = service.createTunnel('c16', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });
    // Let the handshake resolve and the lifecycle handler attach.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // SSH drops before the tunnel is registered.
    lastClient.emit('close');

    await expect(promise).rejects.toThrow(/during tunnel setup/);
    expect(service.hasTunnel('c16')).toBe(false);
  });

  it('closes the local listener when setup aborts after the server is created', async () => {
    listenHangs = true; // stall at the listen stage, after createServer
    const promise = service.createTunnel('c17', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });
    // Let the handshake + pre-flight complete and the server get created.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const createdServer = lastServer;
    lastClient.emit('close'); // drop before registration, while listen is pending

    await expect(promise).rejects.toThrow(/during tunnel setup/);
    // The orphaned listener must be reclaimed, not leaked.
    expect(createdServer.close).toHaveBeenCalled();
    expect(service.hasTunnel('c17')).toBe(false);
  });

  it('rejects a file key that escapes the key dir via a symlink', async () => {
    process.env[SSH_KEY_DIR_ENV] = '/keys';
    (fs.realpathSync as unknown as jest.Mock).mockImplementation((p: string) =>
      p === '/keys/link' ? '/etc/shadow' : p,
    );
    await expect(
      service.createTunnel('c15', {
        sshHost: 'bastion',
        sshPort: SSH_DEFAULT_PORT,
        sshUsername: 'user',
        authMethod: 'privateKey',
        keySource: 'file',
        privateKeyPath: 'link',
        remoteHost: 'db.internal',
        remotePort: DEFAULT_REDIS_PORT,
      }),
    ).rejects.toThrow(/escapes .* via a symlink/);
  });

  it('chains two hops, riding the second inside the first', async () => {
    const { Client } = jest.requireMock('ssh2') as { Client: jest.Mock };
    const seenPins: string[] = [];
    const port = await service.createTunnel('c-chain', {
      sshHost: 'outer',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'u1',
      authMethod: 'password',
      password: 's1',
      hops: [
        { sshHost: 'outer', sshPort: SSH_DEFAULT_PORT, sshUsername: 'u1', authMethod: 'password', password: 's1' },
        {
          sshHost: 'inner',
          sshPort: 2222,
          sshUsername: 'u2',
          authMethod: 'password',
          password: 's2',
          onHostKey: (fp) => seenPins.push(fp),
        },
      ],
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });

    expect(port).toBe(MOCK_TUNNEL_PORT);
    expect(Client).toHaveBeenCalledTimes(2);
    const secondConnect = (lastClient as unknown as { connect: jest.Mock }).connect;
    expect(secondConnect).toHaveBeenCalledWith(expect.objectContaining({ sock: expect.anything() }));
    expect(seenPins).toHaveLength(1);
    expect(service.hasTunnel('c-chain')).toBe(true);
  });

  it('rejects more hops than the maximum', async () => {
    const hops = Array.from({ length: SSH_MAX_HOPS + 1 }, (_, i) => ({
      sshHost: `b${i}`,
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'u',
      authMethod: 'password' as const,
      password: 's',
    }));
    await expect(
      service.createTunnel('c-many', {
        sshHost: 'b0',
        sshPort: SSH_DEFAULT_PORT,
        sshUsername: 'u',
        authMethod: 'password',
        password: 's',
        hops,
        remoteHost: 'db.internal',
        remotePort: DEFAULT_REDIS_PORT,
      }),
    ).rejects.toThrow(/Too many SSH hops/);
  });

  it('opens per-node forwards through the same chain and caches them', async () => {
    await service.createTunnel('c-nodes', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });
    const p1 = await service.createNodeForward('c-nodes', '10.0.1.5', DEFAULT_REDIS_PORT);
    const p2 = await service.createNodeForward('c-nodes', '10.0.1.5', DEFAULT_REDIS_PORT);
    expect(p1).toBe(p2);
    await service.closeTunnel('c-nodes');
    expect(service.hasTunnel('c-nodes')).toBe(false);
  });

  it('refuses node forwards without an established tunnel', async () => {
    await expect(service.createNodeForward('c-missing', '10.0.1.5', DEFAULT_REDIS_PORT)).rejects.toThrow(
      /SSH tunnel is not established/,
    );
  });

  it('refuses node forwards beyond the maximum', async () => {
    await service.createTunnel('c-node-cap', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });
    for (let i = 0; i < SSH_MAX_NODE_FORWARDS; i++) {
      await service.createNodeForward('c-node-cap', `10.0.1.${i}`, DEFAULT_REDIS_PORT);
    }
    await expect(
      service.createNodeForward('c-node-cap', '10.0.2.1', DEFAULT_REDIS_PORT),
    ).rejects.toThrow(/Too many SSH node forwards/);
    await service.closeTunnel('c-node-cap');
  });

  it('dedupes concurrent createNodeForward for the same key (inflight)', async () => {
    await service.createTunnel('c-dedupe', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });
    let callCount = 0;
    const origForwardOut = lastClient.forwardOut;
    (lastClient as unknown as { forwardOut: jest.Mock }).forwardOut = jest.fn((...args: unknown[]) => {
      callCount++;
      const cb = args[4] as (err?: Error, stream?: unknown) => void;
      setImmediate(() => cb(undefined, { end: jest.fn(), pipe: jest.fn(), on: jest.fn(), destroy: jest.fn() }));
    });
    const p1 = service.createNodeForward('c-dedupe', '10.0.1.5', DEFAULT_REDIS_PORT);
    const p2 = service.createNodeForward('c-dedupe', '10.0.1.5', DEFAULT_REDIS_PORT);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(callCount).toBe(1);
    expect(lastClient.forwardOut).toHaveBeenCalledTimes(1);
    const r3 = await service.createNodeForward('c-dedupe', '10.0.1.5', DEFAULT_REDIS_PORT);
    expect(r3).toBe(r1);
    expect(callCount).toBe(1);
    (lastClient as unknown as { forwardOut: jest.Mock }).forwardOut = origForwardOut;
    await service.closeTunnel('c-dedupe');
  });

  it('evicts a per-node forward via closeNodeForward and frees the cap', async () => {
    await service.createTunnel('c-evict', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });
    for (let i = 0; i < SSH_MAX_NODE_FORWARDS; i++) {
      await service.createNodeForward('c-evict', `10.0.1.${i}`, DEFAULT_REDIS_PORT);
    }
    service.closeNodeForward('c-evict', '10.0.1.0', DEFAULT_REDIS_PORT);
    const p = await service.createNodeForward('c-evict', '10.0.2.99', DEFAULT_REDIS_PORT);
    expect(p).toBe(MOCK_TUNNEL_PORT);
    await expect(service.createNodeForward('c-evict', '10.0.1.0', DEFAULT_REDIS_PORT)).rejects.toThrow(/Too many SSH node forwards/);
    service.closeNodeForward('c-evict', '10.0.2.99', DEFAULT_REDIS_PORT);
    const p2 = await service.createNodeForward('c-evict', '10.0.1.0', DEFAULT_REDIS_PORT);
    expect(p2).toBe(MOCK_TUNNEL_PORT);
    await service.closeTunnel('c-evict');
  });

  it('tombstones an inflight forward when evicted before it registers (no ownerless leak)', async () => {
    await service.createTunnel('c-tomb', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });
    let probeCb: (err?: Error, stream?: unknown) => void = () => {};
    const origForwardOut = lastClient.forwardOut;
    (lastClient as unknown as { forwardOut: jest.Mock }).forwardOut = jest.fn((_a: unknown, _b: unknown, _c: unknown, _d: unknown, cb: unknown) => {
      probeCb = cb as typeof probeCb;
    });
    const pending = service.createNodeForward('c-tomb', '10.0.1.5', DEFAULT_REDIS_PORT);
    await new Promise((r) => setImmediate(r));
    service.closeNodeForward('c-tomb', '10.0.1.5', DEFAULT_REDIS_PORT);
    (lastClient as unknown as { forwardOut: jest.Mock }).forwardOut = jest.fn((_a: unknown, _b: unknown, _c: unknown, _d: unknown, cb: unknown) => {
      (cb as (err?: Error, stream?: unknown) => void)(undefined, { end: jest.fn(), pipe: jest.fn(), on: jest.fn(), destroy: jest.fn() });
    });
    probeCb(undefined, { end: jest.fn(), pipe: jest.fn(), on: jest.fn(), destroy: jest.fn() });
    await expect(pending).rejects.toThrow(/evicted while being created|timed out|not established/);
    for (let i = 0; i < SSH_MAX_NODE_FORWARDS; i++) {
      await service.createNodeForward('c-tomb', `10.1.1.${i}`, DEFAULT_REDIS_PORT);
    }
    await expect(service.createNodeForward('c-tomb', '10.0.9.9', DEFAULT_REDIS_PORT)).rejects.toThrow(/Too many SSH node forwards/);
    await service.closeTunnel('c-tomb');
    (lastClient as unknown as { forwardOut: jest.Mock }).forwardOut = origForwardOut;
  });

  it('destroys per-node sockets on eviction (shared-socket lesson)', async () => {
    await service.createTunnel('c-sock', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });
    await service.createNodeForward('c-sock', '10.0.1.5', DEFAULT_REDIS_PORT);
    const nodeServer = lastServer;
    const socket = new EventEmitter() as EventEmitter & { destroy: jest.Mock; pipe: jest.Mock };
    socket.destroy = jest.fn();
    socket.pipe = jest.fn();
    nodeServer.connectionHandler(socket);
    service.closeNodeForward('c-sock', '10.0.1.5', DEFAULT_REDIS_PORT);
    expect(socket.destroy).toHaveBeenCalled();
    expect(nodeServer.close).toHaveBeenCalled();
    await service.closeTunnel('c-sock');
  });

  it('times out a hung per-node forward with a single shared budget', async () => {
    await service.createTunnel('c-timeout', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });
    jest.useFakeTimers();
    (lastClient as unknown as { forwardOut: jest.Mock }).forwardOut = jest.fn(() => {});
    const promise = service.createNodeForward('c-timeout', '10.0.1.5', DEFAULT_REDIS_PORT);
    jest.advanceTimersByTime(SSH_NODE_FORWARD_TIMEOUT_MS);
    await expect(promise).rejects.toThrow(
      new RegExp(`timed out after ${SSH_NODE_FORWARD_TIMEOUT_MS}ms`),
    );
    jest.useRealTimers();
    (lastClient as unknown as { forwardOut: jest.Mock }).forwardOut = jest.fn((_a, _b, _c, _d, cb: (err?: Error, stream?: unknown) => void) => {
      cb(undefined, { end: jest.fn(), pipe: jest.fn(), on: jest.fn(), destroy: jest.fn() });
    });
    const p2 = await service.createNodeForward('c-timeout', '10.0.1.5', DEFAULT_REDIS_PORT);
    expect(p2).toBe(MOCK_TUNNEL_PORT);
    await service.closeTunnel('c-timeout');
  });

  it('does not register a forward if tunnel was replaced while binding', async () => {
    await service.createTunnel('c-stale', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: DEFAULT_REDIS_PORT,
    });
    let listenCb: () => void = () => {};
    const origCreateServer = (jest.requireMock('net') as { createServer: jest.Mock }).createServer;
    let perNodeServer: { close: jest.Mock };
    (jest.requireMock('net') as { createServer: jest.Mock }).createServer.mockImplementationOnce((handler: unknown) => {
      const { EventEmitter: EE } = jest.requireActual('events') as { EventEmitter: new () => EventEmitter };
      const server = new EE() as EventEmitter & { listen: jest.Mock; address: jest.Mock; close: jest.Mock; connectionHandler: unknown };
      server.connectionHandler = handler;
      server.listen = jest.fn((_p: number, _h: string, cb: () => void) => {
        listenCb = cb;
      });
      server.address = jest.fn(() => ({ port: MOCK_TUNNEL_PORT }));
      server.close = jest.fn((cb?: () => void) => { if (cb) cb(); });
      perNodeServer = server;
      lastServer = server;
      return server;
    });
    const pending = service.createNodeForward('c-stale', '10.0.1.5', DEFAULT_REDIS_PORT);
    await new Promise((r) => setImmediate(r));
    await service.createTunnel('c-stale', {
      sshHost: 'bastion',
      sshPort: SSH_DEFAULT_PORT,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: 6380,
    });
    listenCb!();
    await expect(pending).rejects.toThrow(/SSH tunnel is not established/);
    await service.closeTunnel('c-stale');
    (jest.requireMock('net') as { createServer: jest.Mock }).createServer = origCreateServer;
  });
});

describe('hostKeyMatchesFingerprint', () => {
  const key = Buffer.from('some-host-key-bytes');
  const sha = createHash('sha256').update(key).digest();

  it('matches an OpenSSH SHA256:<base64> fingerprint (padding optional)', () => {
    const b64 = sha.toString('base64').replace(/=+$/, '');
    expect(hostKeyMatchesFingerprint(key, `SHA256:${b64}`)).toBe(true);
    expect(hostKeyMatchesFingerprint(key, b64)).toBe(true);
  });

  it('matches a full ssh-keygen -lf line (the documented paste format)', () => {
    const b64 = sha.toString('base64').replace(/=+$/, '');
    const keygenLine = `256 SHA256:${b64} bastion.example.com (ED25519)`;
    expect(hostKeyMatchesFingerprint(key, keygenLine)).toBe(true);
  });

  it('matches a hex fingerprint case-insensitively, ignoring colons', () => {
    const hex = sha.toString('hex');
    const colonized = hex.match(/../g)!.join(':').toUpperCase();
    expect(hostKeyMatchesFingerprint(key, colonized)).toBe(true);
  });

  it('rejects a non-matching fingerprint', () => {
    expect(hostKeyMatchesFingerprint(key, 'SHA256:AAAA')).toBe(false);
  });
});
