import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Client } from 'ssh2';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
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
  /** Final destination reachable from the SSH server. */
  remoteHost: string;
  remotePort: number;
}

interface TunnelInfo {
  client: Client;
  server: net.Server;
  localPort: number;
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

    await new Promise<void>((resolve, reject) => {
      sshClient.on('ready', () => {
        this.logger.log(`[${connectionId}] SSH connection established`);
        resolve();
      });
      sshClient.on('error', (err: Error & { level?: string }) => {
        if (err.level === 'client-authentication') {
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

      sshClient.connect({
        host: params.sshHost,
        port: params.sshPort,
        username: params.sshUsername,
        password: params.authMethod === 'password' ? params.password : undefined,
        privateKey: params.authMethod === 'privateKey' ? privateKey : undefined,
        passphrase: params.authMethod === 'privateKey' ? params.passphrase : undefined,
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

      const server = net.createServer((socket) => {
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

      // Tear the local listener down if the SSH connection drops.
      sshClient.on('error', () => {
        this.closeTunnel(connectionId).catch(() => {});
      });
      sshClient.on('close', () => {
        const tunnel = this.tunnels.get(connectionId);
        if (tunnel) {
          tunnel.server.close();
          this.tunnels.delete(connectionId);
        }
      });

      this.tunnels.set(connectionId, { client: sshClient, server, localPort });
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
