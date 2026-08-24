import { EventEmitter } from 'events';
import { SshTunnelService, SSH_KEY_DIR_ENV } from '../ssh-tunnel.service';

// --- ssh2 mock -------------------------------------------------------------

class MockSshClient extends EventEmitter {
  connect = jest.fn(() => {
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

jest.mock('net', () => {
  const actual = jest.requireActual('events');
  return {
    createServer: jest.fn(() => {
      const server = new actual.EventEmitter();
      server.listen = jest.fn((_port: number, _host: string, cb: () => void) => {
        setImmediate(cb);
      });
      server.address = jest.fn(() => ({ port: 54321 }));
      server.close = jest.fn((cb?: () => void) => {
        if (cb) cb();
      });
      return server;
    }),
  };
});

// --- fs mock for file-based keys -------------------------------------------

jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  readFileSync: jest.fn(() => Buffer.from('FILE-KEY-CONTENT')),
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
});
