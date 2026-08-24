import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Client } from 'ssh2';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { SshAuthMethod, SshKeySource } from '@betterdb/shared';

/**
 * Environment variable naming a directory that server-side SSH private keys
 * (`keySource: 'file'`, option B) must live inside. When unset, file-based keys
 * are rejected so the API can never be coerced into reading arbitrary files.
 */
export const SSH_KEY_DIR_ENV = 'BETTERDB_SSH_KEY_DIR';

/**
 * Runtime tunnel parameters. Secrets here are already decrypted; the caller is
 * responsible for decrypting persisted config before handing it over.
 */
export interface SshTunnelParams {
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  authMethod: SshAuthMethod;
  /** Password for `password` auth. */
  password?: string;
  /** How a private key is provided when `authMethod === 'privateKey'`. */
  keySource?: SshKeySource;
  /** Inline PEM key content (option A) when `keySource === 'inline'`. */
  privateKey?: string;
  /** Server-side key path (option B) when `keySource === 'file'`. */
  privateKeyPath?: string;
  passphrase?: string;
  /** Pinned SHA256 fingerprint of the SSH server host key, if any. */
  hostKeyFingerprint?: string;
  /** Final destination reachable from the SSH server. */
  remoteHost: string;
  remotePort: number;
}

interface TunnelInfo {
  client: Client;
  server: net.Server;
  localPort: number;
  /** Live forwarded sockets, destroyed on teardown so server.close() settles. */
  sockets: Set<net.Socket>;
}

/**
 * Whether an SSH host key matches a pinned SHA256 fingerprint. Accepts the
 * OpenSSH `SHA256:<base64>` form (case-sensitive, padding optional) or a hex
 * digest (case-insensitive, separators like colons ignored).
 */
export function hostKeyMatchesFingerprint(key: Buffer, pin: string): boolean {
  const sha = createHash('sha256').update(key).digest();
  const base64 = sha.toString('base64').replace(/=+$/, '');
  const hex = sha.toString('hex');

  // Accept a full `ssh-keygen -lf` / `ssh-keyscan … | ssh-keygen -lf -` line
  // such as `256 SHA256:<base64> host (ED25519)` by extracting the SHA256 token
  // (base64 alphabet chars only, so the trailing `host (ED25519)` is dropped).
  const sha256Token = pin.match(/SHA256:([A-Za-z0-9+/=]+)/i);
  if (sha256Token) {
    return sha256Token[1].replace(/=+$/, '') === base64;
  }

  // Otherwise treat the input as a bare base64 or hex SHA256 digest.
  const trimmed = pin.trim();
  if (trimmed.replace(/=+$/, '') === base64) return true;

  // Hex must be exactly the 64-char digest so stray chars can't accidentally
  // concatenate into a match.
  const pinHex = trimmed.replace(/[^a-f0-9]/gi, '').toLowerCase();
  return pinHex.length === 64 && pinHex === hex;
}

/**
 * Manages SSH tunnels for database connections. Each tunnel opens an ssh2
 * client, stands up a local `net` server on an ephemeral port, and forwards
 * every accepted socket through the SSH connection to the remote database.
 * The Valkey client then connects to `127.0.0.1:<localPort>` instead of the
 * real host.
 *
 * Ported from the BetterDB VS Code extension's SshTunnelManager, adapted for a
 * server-side NestJS process: private keys arrive either as inline content
 * (option A) or as a path validated against `BETTERDB_SSH_KEY_DIR` (option B).
 */
@Injectable()
export class SshTunnelService implements OnModuleDestroy {
  private readonly logger = new Logger(SshTunnelService.name);
  private readonly tunnels = new Map<string, TunnelInfo>();

  async onModuleDestroy(): Promise<void> {
    await this.closeAll();
  }

  /**
   * Resolve the private key material for a tunnel, enforcing the option-B
   * directory allowlist for file-based keys.
   */
  private resolvePrivateKey(params: SshTunnelParams): Buffer | undefined {
    const keySource: SshKeySource = params.keySource ?? 'inline';

    if (keySource === 'inline') {
      if (!params.privateKey) {
        throw new Error('SSH private key content is required for inline key auth');
      }
      return Buffer.from(params.privateKey);
    }

    // keySource === 'file' (option B): read from the server filesystem, but only
    // from inside the configured allowlist directory.
    if (!params.privateKeyPath) {
      throw new Error('SSH private key path is required for file-based key auth');
    }

    const keyDir = process.env[SSH_KEY_DIR_ENV];
    if (!keyDir || keyDir.trim() === '') {
      throw new Error(
        `Server-side SSH key files are disabled. Set the ${SSH_KEY_DIR_ENV} environment ` +
          'variable to a directory containing allowed private keys to enable this option.',
      );
    }

    const baseDir = path.resolve(keyDir);
    const resolved = path.resolve(baseDir, params.privateKeyPath);
    const rel = path.relative(baseDir, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(
        `SSH private key path must resolve inside ${SSH_KEY_DIR_ENV} (${baseDir})`,
      );
    }

    if (!fs.existsSync(resolved)) {
      throw new Error(`SSH private key file not found: ${resolved}`);
    }
    try {
      return fs.readFileSync(resolved);
    } catch {
      throw new Error(
        'Could not read SSH private key — the file may be in an unsupported format or unreadable',
      );
    }
  }

  /**
   * Create (or replace) a tunnel for the given connection id and return the
   * local port the caller should connect to.
   */
  async createTunnel(connectionId: string, params: SshTunnelParams): Promise<number> {
    this.logger.log(
      `[${connectionId}] Creating SSH tunnel ${params.sshUsername}@${params.sshHost}:${params.sshPort} ` +
        `→ ${params.remoteHost}:${params.remotePort} (auth: ${params.authMethod})`,
    );

    if (this.tunnels.has(connectionId)) {
      await this.closeTunnel(connectionId);
    }

    const privateKey =
      params.authMethod === 'privateKey' ? this.resolvePrivateKey(params) : undefined;

    const sshClient = new Client();
    let hostKeyRejected = false;

    await new Promise<void>((resolve, reject) => {
      sshClient.on('ready', () => {
        this.logger.log(`[${connectionId}] SSH connection established`);
        resolve();
      });
      sshClient.on('error', (err: Error & { level?: string }) => {
        if (hostKeyRejected) {
          reject(
            new Error(
              `SSH host-key verification failed for ${params.sshHost}:${params.sshPort} — the server key does not match the pinned fingerprint`,
            ),
          );
        } else if (err.level === 'client-authentication') {
          reject(
            new Error(
              `SSH authentication failed for ${params.sshUsername}@${params.sshHost}:${params.sshPort} — check your credentials`,
            ),
          );
        } else if (err.message?.includes('ECONNREFUSED')) {
          reject(new Error(`Cannot reach SSH server at ${params.sshHost}:${params.sshPort}`));
        } else if (err.message?.includes('ETIMEDOUT') || err.message?.includes('EHOSTUNREACH')) {
          reject(
            new Error(
              `SSH server at ${params.sshHost}:${params.sshPort} is unreachable — check the hostname and your network`,
            ),
          );
        } else {
          reject(new Error(`SSH connection error: ${err.message}`));
        }
      });

      const pinnedFingerprint = params.hostKeyFingerprint?.trim();
      if (!pinnedFingerprint) {
        this.logger.warn(
          `[${connectionId}] No SSH host-key fingerprint pinned for ${params.sshHost}:${params.sshPort}; ` +
            'the server identity is not verified (set hostKeyFingerprint to prevent MITM).',
        );
      }

      sshClient.connect({
        host: params.sshHost,
        port: params.sshPort,
        username: params.sshUsername,
        password: params.authMethod === 'password' ? params.password : undefined,
        privateKey: params.authMethod === 'privateKey' ? privateKey : undefined,
        passphrase: params.authMethod === 'privateKey' ? params.passphrase : undefined,
        // When a fingerprint is pinned, reject any server whose host key does
        // not match. Without a pin we accept the key (and warned above).
        hostVerifier: (key: Buffer) => {
          if (!pinnedFingerprint) return true;
          const ok = hostKeyMatchesFingerprint(key, pinnedFingerprint);
          if (!ok) {
            hostKeyRejected = true;
            this.logger.error(
              `[${connectionId}] SSH host-key verification failed for ${params.sshHost}:${params.sshPort}`,
            );
          }
          return ok;
        },
      });
    });

    try {
      // Pre-flight: verify the remote database port is reachable through the hop
      // before we expose a local listener, so bad host/port fails fast.
      await new Promise<void>((resolve, reject) => {
        sshClient.forwardOut('127.0.0.1', 0, params.remoteHost, params.remotePort, (err, stream) => {
          if (err) {
            reject(
              new Error(
                `Connected to SSH server, but ${params.remoteHost}:${params.remotePort} refused the connection`,
              ),
            );
          } else {
            stream.end();
            resolve();
          }
        });
      });

      const sockets = new Set<net.Socket>();
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        sshClient.forwardOut(
          '127.0.0.1',
          0,
          params.remoteHost,
          params.remotePort,
          (err, stream) => {
            if (err) {
              socket.destroy(
                new Error(
                  `SSH tunnel forwarding failed to ${params.remoteHost}:${params.remotePort}: ${err.message}`,
                ),
              );
              return;
            }
            socket.pipe(stream);
            stream.pipe(socket);
            socket.on('error', () => stream.destroy());
            stream.on('error', () => socket.destroy());
            stream.on('close', () => socket.destroy());
          },
        );
      });

      const localPort = await new Promise<number>((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            resolve(addr.port);
          } else {
            reject(new Error('Failed to bind local tunnel port'));
          }
        });
      });

      const info: TunnelInfo = { client: sshClient, server, localPort, sockets };

      // Tear the local listener down if the SSH connection drops. Compare
      // identity so a stale handler from a replaced tunnel never closes the
      // tunnel that superseded it under the same id.
      sshClient.on('error', () => {
        if (this.tunnels.get(connectionId) === info) {
          this.closeTunnel(connectionId).catch(() => {});
        }
      });
      sshClient.on('close', () => {
        if (this.tunnels.get(connectionId) === info) {
          this.tunnels.delete(connectionId);
        }
        server.close();
      });

      this.tunnels.set(connectionId, info);
      this.logger.log(`[${connectionId}] SSH tunnel listening on 127.0.0.1:${localPort}`);
      return localPort;
    } catch (err) {
      sshClient.end();
      throw err;
    }
  }

  async closeTunnel(connectionId: string): Promise<void> {
    const tunnel = this.tunnels.get(connectionId);
    if (!tunnel) {
      return;
    }
    this.tunnels.delete(connectionId);
    // Destroy live forwarded sockets first: net.Server.close() only invokes its
    // callback once every open connection has ended, so a still-connected
    // database client would otherwise hang teardown (and onModuleDestroy).
    for (const socket of tunnel.sockets) {
      socket.destroy();
    }
    tunnel.sockets.clear();
    await new Promise<void>((resolve) => {
      tunnel.server.close(() => resolve());
    });
    tunnel.client.end();
  }

  async closeAll(): Promise<void> {
    const ids = [...this.tunnels.keys()];
    await Promise.all(ids.map((id) => this.closeTunnel(id)));
  }

  hasTunnel(connectionId: string): boolean {
    return this.tunnels.has(connectionId);
  }
}
