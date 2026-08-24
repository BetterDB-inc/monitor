import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import {
  SshTunnelService,
  SSH_KEY_DIR_ENV,
  hostKeyMatchesFingerprint,
} from '../ssh-tunnel.service';

// --- ssh2 mock -------------------------------------------------------------

const FAKE_HOST_KEY = Buffer.from('FAKE-HOST-KEY');

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
jest.mock('net', () => {
  const actual = jest.requireActual('events');
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createServer: jest.fn((connectionHandler: (socket: any) => void) => {
      const server = new actual.EventEmitter();
      server.connectionHandler = connectionHandler;
      server.listen = jest.fn((_port: number, _host: string, cb: () => void) => {
        setImmediate(cb);
      });
      server.address = jest.fn(() => ({ port: 54321 }));
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
    delete process.env[SSH_KEY_DIR_ENV];
    service = new SshTunnelService();
  });

  it('creates a password-auth tunnel and returns the local port', async () => {
    const port = await service.createTunnel('c1', {
      sshHost: 'bastion',
      sshPort: 22,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: 6379,
    });

    expect(port).toBe(54321);
    expect(service.hasTunnel('c1')).toBe(true);
    expect(lastClient.connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'bastion', port: 22, username: 'user', password: 'secret' }),
    );
  });

  it('creates a tunnel with an inline private key', async () => {
    const port = await service.createTunnel('c2', {
      sshHost: 'bastion',
      sshPort: 22,
      sshUsername: 'user',
      authMethod: 'privateKey',
      keySource: 'inline',
      privateKey: '-----BEGIN KEY-----',
      remoteHost: 'db.internal',
      remotePort: 6379,
    });

    expect(port).toBe(54321);
    const connectArg = (lastClient.connect.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(connectArg.privateKey).toEqual(Buffer.from('-----BEGIN KEY-----'));
  });

  it('rejects a file-based key when BETTERDB_SSH_KEY_DIR is unset', async () => {
    await expect(
      service.createTunnel('c3', {
        sshHost: 'bastion',
        sshPort: 22,
        sshUsername: 'user',
        authMethod: 'privateKey',
        keySource: 'file',
        privateKeyPath: 'id_ed25519',
        remoteHost: 'db.internal',
        remotePort: 6379,
      }),
    ).rejects.toThrow(new RegExp(SSH_KEY_DIR_ENV));
    expect(service.hasTunnel('c3')).toBe(false);
  });

  it('reads a file-based key from inside BETTERDB_SSH_KEY_DIR', async () => {
    process.env[SSH_KEY_DIR_ENV] = '/keys';
    const port = await service.createTunnel('c4', {
      sshHost: 'bastion',
      sshPort: 22,
      sshUsername: 'user',
      authMethod: 'privateKey',
      keySource: 'file',
      privateKeyPath: 'id_ed25519',
      remoteHost: 'db.internal',
      remotePort: 6379,
    });

    expect(port).toBe(54321);
    expect(fs.readFileSync).toHaveBeenCalledWith('/keys/id_ed25519');
    const connectArg = (lastClient.connect.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(connectArg.privateKey).toEqual(Buffer.from('FILE-KEY-CONTENT'));
  });

  it('blocks path traversal outside BETTERDB_SSH_KEY_DIR', async () => {
    process.env[SSH_KEY_DIR_ENV] = '/keys';
    await expect(
      service.createTunnel('c5', {
        sshHost: 'bastion',
        sshPort: 22,
        sshUsername: 'user',
        authMethod: 'privateKey',
        keySource: 'file',
        privateKeyPath: '../../etc/shadow',
        remoteHost: 'db.internal',
        remotePort: 6379,
      }),
    ).rejects.toThrow(/must resolve inside/);
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('closes a tunnel and forgets it', async () => {
    await service.createTunnel('c6', {
      sshHost: 'bastion',
      sshPort: 22,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: 6379,
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
      sshPort: 22,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      hostKeyFingerprint: fingerprint,
      remoteHost: 'db.internal',
      remotePort: 6379,
    });
    expect(port).toBe(54321);
  });

  it('rejects the server when the pinned host-key fingerprint does not match', async () => {
    await expect(
      service.createTunnel('c8', {
        sshHost: 'bastion',
        sshPort: 22,
        sshUsername: 'user',
        authMethod: 'password',
        password: 'secret',
        hostKeyFingerprint: 'SHA256:definitelywrongfingerprint',
        remoteHost: 'db.internal',
        remotePort: 6379,
      }),
    ).rejects.toThrow(/host-key verification failed/);
    expect(service.hasTunnel('c8')).toBe(false);
  });

  it('destroys live forwarded sockets on closeTunnel so server.close settles', async () => {
    await service.createTunnel('c9', {
      sshHost: 'bastion',
      sshPort: 22,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: 6379,
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
      sshPort: 22,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: 6379,
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
      sshPort: 22,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      onHostKey,
      remoteHost: 'db.internal',
      remotePort: 6379,
    });
    const expected =
      'SHA256:' + createHash('sha256').update(FAKE_HOST_KEY).digest('base64').replace(/=+$/, '');
    expect(onHostKey).toHaveBeenCalledWith(expected);
  });

  it('sets tryKeyboard for password auth so PAM bastions work', async () => {
    await service.createTunnel('c12', {
      sshHost: 'bastion',
      sshPort: 22,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      remoteHost: 'db.internal',
      remotePort: 6379,
    });
    const opts = (lastClient.connect.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(opts.tryKeyboard).toBe(true);
  });

  it('signals onUnexpectedClose when an established tunnel drops', async () => {
    const onUnexpectedClose = jest.fn();
    await service.createTunnel('c13', {
      sshHost: 'bastion',
      sshPort: 22,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      onUnexpectedClose,
      remoteHost: 'db.internal',
      remotePort: 6379,
    });
    lastClient.emit('close');
    expect(onUnexpectedClose).toHaveBeenCalled();
    expect(service.hasTunnel('c13')).toBe(false);
  });

  it('does not signal onUnexpectedClose after an explicit closeTunnel', async () => {
    const onUnexpectedClose = jest.fn();
    await service.createTunnel('c14', {
      sshHost: 'bastion',
      sshPort: 22,
      sshUsername: 'user',
      authMethod: 'password',
      password: 'secret',
      onUnexpectedClose,
      remoteHost: 'db.internal',
      remotePort: 6379,
    });
    await service.closeTunnel('c14');
    lastClient.emit('close'); // late close event from the ended client
    expect(onUnexpectedClose).not.toHaveBeenCalled();
  });

  it('rejects a file key that escapes the key dir via a symlink', async () => {
    process.env[SSH_KEY_DIR_ENV] = '/keys';
    (fs.realpathSync as unknown as jest.Mock).mockImplementation((p: string) =>
      p === '/keys/link' ? '/etc/shadow' : p,
    );
    await expect(
      service.createTunnel('c15', {
        sshHost: 'bastion',
        sshPort: 22,
        sshUsername: 'user',
        authMethod: 'privateKey',
        keySource: 'file',
        privateKeyPath: 'link',
        remoteHost: 'db.internal',
        remotePort: 6379,
      }),
    ).rejects.toThrow(/escapes .* via a symlink/);
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
