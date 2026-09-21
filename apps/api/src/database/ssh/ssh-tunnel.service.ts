import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Client } from 'ssh2';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { SshAuthMethod, SshKeySource } from '@betterdb/shared';
import {
  SSH_DEFAULT_PORT,
  SSH_MAX_HOPS,
  SSH_MAX_NODE_FORWARDS,
  SSH_NODE_FORWARD_TIMEOUT_MS,
} from '@betterdb/shared';

/**
 * Environment variable naming a directory that server-side SSH private keys
 * (`keySource: 'file'`, option B) must live inside. When unset, file-based keys
 * are rejected so the API can never be coerced into reading arbitrary files.
 */
export const SSH_KEY_DIR_ENV = 'BETTERDB_SSH_KEY_DIR';

/**
 * One bastion hop in a chained tunnel. Secrets here are already decrypted;
 * the caller is responsible for decrypting persisted config before handing it
 * over.
 */
export interface SshHopParams {
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  authMethod: SshAuthMethod;
  password?: string;
  keySource?: SshKeySource;
  privateKey?: string;
  privateKeyPath?: string;
  passphrase?: string;
  hostKeyFingerprint?: string;
  /** Observed host-key fingerprint, when no fingerprint was pinned for this hop. */
  onHostKey?: (fingerprint: string) => void;
}

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
  /** Ordered bastion hops, outermost first. Non-empty overrides the top-level fields. */
  hops?: SshHopParams[];
  /** Final destination reachable from the last hop. */
  remoteHost: string;
  remotePort: number;
  /**
   * Called with the observed `SHA256:<base64>` host-key fingerprint during the
   * handshake when no fingerprint was pinned — enables trust-on-first-use
   * (the caller can persist it so subsequent connects are verified).
   */
  onHostKey?: (fingerprint: string) => void;
  /**
   * Called when an already-established tunnel drops on its own (SSH error or
   * close), as opposed to an explicit `closeTunnel()`. Lets the owner stop
   * dialing the now-dead local port and re-establish.
   */
  onUnexpectedClose?: () => void;
}

/** Compute the OpenSSH-style `SHA256:<base64>` fingerprint of a host key. */
function hostKeyFingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}



interface TunnelInfo {
  clients: Client[];
  servers: net.Server[];
  localPort: number;
  /** Live forwarded sockets, destroyed on teardown so server.close() settles. */
  sockets: Set<net.Socket>;
  nodePorts: Map<string, number>;
  /** Per-node loopback servers keyed by `remoteHost:remotePort` for eviction. */
  nodeServers: Map<string, net.Server>;
  /** In-flight per-node forward creations keyed by `remoteHost:remotePort`. */
  nodeForwardInflight: Map<string, Promise<number>>;
  /** Sockets accepted by each per-node server, for targeted destroy on eviction. */
  nodeSockets: Map<string, Set<net.Socket>>;
  /** Keys requested for eviction while inflight — re-checked after creation settles. */
  nodeTombstones: Set<string>;
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

interface ResolvedHop extends SshHopParams {
  label: string;
}

/**
 * Manages SSH tunnels for database connections. Each tunnel opens an ssh2
 * client per bastion hop, stands up a local `net` server on an ephemeral
 * port, and forwards every accepted socket through the chain to the remote
 * database. The Valkey client then connects to `127.0.0.1:<localPort>`
 * instead of the real host.
 */
@Injectable()
export class SshTunnelService implements OnModuleDestroy {
  private readonly logger = new Logger(SshTunnelService.name);
  private readonly tunnels = new Map<string, TunnelInfo>();

  async onModuleDestroy(): Promise<void> {
    await this.closeAll();
  }

  /**
   * Resolve the private key material for a hop, enforcing the option-B
   * directory allowlist for file-based keys.
   */
  private resolvePrivateKeyForHop(hop: {
    keySource?: SshKeySource;
    privateKey?: string;
    privateKeyPath?: string;
  }): Buffer | undefined {
    const keySource: SshKeySource = hop.keySource ?? 'inline';

    if (keySource === 'inline') {
      if (!hop.privateKey) {
        throw new Error('SSH private key content is required for inline key auth');
      }
      return Buffer.from(hop.privateKey);
    }

    // keySource === 'file' (option B): read from the server filesystem, but only
    // from inside the configured allowlist directory.
    if (!hop.privateKeyPath) {
      throw new Error('SSH private key path is required for file-based key auth');
    }

    const keyDir = process.env[SSH_KEY_DIR_ENV];
    if (!keyDir || keyDir.trim() === '') {
      throw new Error(
        `Server-side SSH key files are disabled. Set the ${SSH_KEY_DIR_ENV} environment ` +
          'variable to a directory containing allowed private keys to enable this option.',
      );
    }

    // Resolve symlinks on the base dir itself so the containment comparison is
    // against a canonical path.
    const baseDir = fs.realpathSync(path.resolve(keyDir));
    const resolved = path.resolve(baseDir, hop.privateKeyPath);
    const contains = (candidate: string): boolean => {
      const rel = path.relative(baseDir, candidate);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    // Lexical check first (fast reject for `../` traversal on a non-existent path).
    if (!contains(resolved)) {
      throw new Error(
        `SSH private key path must resolve inside ${SSH_KEY_DIR_ENV} (${baseDir})`,
      );
    }

    if (!fs.existsSync(resolved)) {
      throw new Error(`SSH private key file not found: ${resolved}`);
    }
    // Then resolve symlinks on the target and re-check: a symlink inside the key
    // dir pointing at, say, /etc/shadow passes the lexical check but must not
    // escape the allowlist once its real path is known.
    const realResolved = fs.realpathSync(resolved);
    if (!contains(realResolved)) {
      throw new Error(
        `SSH private key path escapes ${SSH_KEY_DIR_ENV} via a symlink (${baseDir})`,
      );
    }
    try {
      return fs.readFileSync(realResolved);
    } catch {
      throw new Error(
        'Could not read SSH private key — the file may be in an unsupported format or unreadable',
      );
    }
  }

  private resolveHops(params: SshTunnelParams): ResolvedHop[] {
    const raw: SshHopParams[] =
      params.hops && params.hops.length > 0
        ? params.hops
        : [
            {
              sshHost: params.sshHost,
              sshPort: params.sshPort,
              sshUsername: params.sshUsername,
              authMethod: params.authMethod,
              password: params.password,
              keySource: params.keySource,
              privateKey: params.privateKey,
              privateKeyPath: params.privateKeyPath,
              passphrase: params.passphrase,
              hostKeyFingerprint: params.hostKeyFingerprint,
              onHostKey: params.onHostKey,
            },
          ];
    if (raw.length > SSH_MAX_HOPS) {
      throw new Error(
        `Too many SSH hops (${raw.length}); at most ${SSH_MAX_HOPS} are supported`,
      );
    }
    return raw.map((hop, i) => {
      if (!hop.sshHost || typeof hop.sshHost !== 'string' || hop.sshHost.trim() === '') {
        throw new Error(`SSH hop ${i + 1}/${raw.length} is missing its host`);
      }
      if (!hop.sshUsername || hop.sshUsername.trim() === '') {
        throw new Error(`SSH hop ${i + 1}/${raw.length} (${hop.sshHost}) is missing its username`);
      }
      const port = hop.sshPort ?? SSH_DEFAULT_PORT;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`SSH hop ${i + 1}/${raw.length} (${hop.sshHost}) has an invalid port`);
      }
      return {
        ...hop,
        sshHost: hop.sshHost.trim(),
        sshPort: port,
        label: `hop ${i + 1}/${raw.length} (${hop.sshUsername}@${hop.sshHost.trim()}:${port})`,
      };
    });
  }

  private forwardOutPromise(
    client: Client,
    dstHost: string,
    dstPort: number,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, dstHost, dstPort, (err, stream) => {
        if (err) {
          reject(err);
        } else {
          resolve(stream);
        }
      });
    });
  }

  /** Connect a single hop; `sock` rides inside the previous hop for hops beyond the first. */
  private connectOneHop(
    connectionId: string,
    hop: ResolvedHop,
    sock: any | undefined,
    fallbackOnHostKey: ((fingerprint: string) => void) | undefined,
  ): Promise<Client> {
    let privateKey: Buffer | undefined;
    if (hop.authMethod === 'privateKey') {
      try {
        privateKey = this.resolvePrivateKeyForHop(hop);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`SSH ${hop.label}: ${detail}`);
      }
    }
    const sshClient = new Client();
    let hostKeyRejected = false;
    const pinnedFingerprint = hop.hostKeyFingerprint?.trim() || undefined;

    // ssh2 only attempts keyboard-interactive when told to. Many bastions run
    // PAM (`KbdInteractiveAuthentication yes`) and advertise that instead of
    // plain `password`, so answer the interactive prompts with the password.
    const usePassword = hop.authMethod === 'password';
    if (usePassword && hop.password) {
      sshClient.on(
        'keyboard-interactive',
        (_name, _instructions, _lang, _prompts, finish) => {
          finish([hop.password as string]);
        },
      );
    }

    return new Promise<void>((resolve, reject) => {
      // Remove these once the handshake settles so a later (post-ready) drop is
      // handled by the lifecycle handler rather than hitting an
      // already-resolved reject that silently no-ops.
      const cleanup = () => {
        sshClient.off('ready', onReady);
        sshClient.off('error', onError);
      };
      const onReady = () => {
        cleanup();
        this.logger.log(`[${connectionId}] SSH connection established (${hop.label})`);
        resolve();
      };
      const onError = (err: Error & { level?: string }) => {
        cleanup();
        if (hostKeyRejected) {
          reject(
            new Error(
              `SSH host-key verification failed for ${hop.sshHost}:${hop.sshPort} — the server key does not match the pinned fingerprint`,
            ),
          );
        } else if (err.level === 'client-authentication') {
          reject(
            new Error(
              `SSH authentication failed for ${hop.sshUsername}@${hop.sshHost}:${hop.sshPort} — check your credentials`,
            ),
          );
        } else if (err.message?.includes('ECONNREFUSED')) {
          reject(new Error(`Cannot reach SSH server at ${hop.sshHost}:${hop.sshPort}`));
        } else if (err.message?.includes('ETIMEDOUT') || err.message?.includes('EHOSTUNREACH')) {
          reject(
            new Error(
              `SSH server at ${hop.sshHost}:${hop.sshPort} is unreachable — check the hostname and your network`,
            ),
          );
        } else {
          reject(new Error(`SSH connection error: ${err.message}`));
        }
      };
      sshClient.on('ready', onReady);
      sshClient.on('error', onError);

      sshClient.connect({
        host: hop.sshHost,
        port: hop.sshPort,
        username: hop.sshUsername,
        password: usePassword ? hop.password : undefined,
        tryKeyboard: usePassword,
        privateKey: hop.authMethod === 'privateKey' ? privateKey : undefined,
        passphrase: hop.authMethod === 'privateKey' ? hop.passphrase : undefined,
        ...(sock ? { sock } : {}),
        hostVerifier: (key: Buffer) => {
          const observed = hostKeyFingerprintOf(key);
          // Trust-on-first-use: no pin yet. Accept, but hand the observed
          // fingerprint back so the caller can persist and verify it next time.
          if (!pinnedFingerprint) {
            const notify = hop.onHostKey ?? fallbackOnHostKey;
            if (notify) {
              notify(observed);
              this.logger.log(
                `[${connectionId}] Trusting SSH host key on first use (${hop.label} ${observed}); it will be pinned.`,
              );
            } else {
              this.logger.warn(
                `[${connectionId}] SSH host key not verified for ${hop.sshHost}:${hop.sshPort} (${observed}); ` +
                  'set hostKeyFingerprint to prevent MITM.',
              );
            }
            return true;
          }
          // Pinned: reject any server whose key does not match.
          const ok = hostKeyMatchesFingerprint(key, pinnedFingerprint);
          if (!ok) {
            hostKeyRejected = true;
            this.logger.error(
              `[${connectionId}] SSH host-key verification failed for ${hop.sshHost}:${hop.sshPort} ` +
                `(pinned ${pinnedFingerprint}, server presented ${observed})`,
            );
          }
          return ok;
        },
      });
    }).then(() => sshClient);
  }

  private async listenForwarded(
    connectionId: string,
    client: Client,
    sockets: Set<net.Socket>,
    remoteHost: string,
    remotePort: number,
    aborted: Promise<never>,
    onServer?: (server: net.Server) => void,
    perNodeSockets?: Set<net.Socket>,
  ): Promise<{ server: net.Server; localPort: number }> {
    const server = net.createServer((socket) => {
      sockets.add(socket);
      perNodeSockets?.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
        perNodeSockets?.delete(socket);
      });
      // Attach an error listener immediately. Without it, a socket error
      // during the async forwardOut window — or the destroy() on the
      // forwarding-failure path below — would emit 'error' with no listener
      // and crash the whole process via the global uncaughtException handler.
      socket.on('error', () => socket.destroy());
      client.forwardOut(
        '127.0.0.1',
        0,
        remoteHost,
        remotePort,
        (err, stream) => {
          if (err) {
            this.logger.warn(
              `[${connectionId}] SSH forwarding failed to ${remoteHost}:${remotePort}: ${err.message}`,
            );
            // destroy() with no argument does not emit 'error'.
            socket.destroy();
            return;
          }
          socket.pipe(stream);
          stream.pipe(socket);
          // Once piped, a socket error should also tear down the stream.
          socket.on('error', () => stream.destroy());
          stream.on('error', () => socket.destroy());
          stream.on('close', () => socket.destroy());
        },
      );
    });
    onServer?.(server);

    const localPort = await Promise.race([
      aborted,
      new Promise<number>((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            resolve(addr.port);
          } else {
            reject(new Error('Failed to bind local tunnel port'));
          }
        });
      }),
    ]);
    return { server, localPort };
  }

  /**
   * Create (or replace) a tunnel for the given connection id and return the
   * local port the caller should connect to.
   */
  async createTunnel(connectionId: string, params: SshTunnelParams): Promise<number> {
    const hops = this.resolveHops(params);
    const chainDesc = hops.map((h) => `${h.sshUsername}@${h.sshHost}:${h.sshPort}`).join(' → ');
    this.logger.log(
      `[${connectionId}] Creating SSH tunnel ${chainDesc} ` +
        `→ ${params.remoteHost}:${params.remotePort} (${hops.length} hop(s), auth: ${hops.map((h) => h.authMethod).join('/')})`,
    );

    if (this.tunnels.has(connectionId)) {
      await this.closeTunnel(connectionId);
    }

    for (const hop of hops) {
      if (hop.authMethod === 'privateKey') {
        try {
          this.resolvePrivateKeyForHop(hop);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(`SSH ${hop.label}: ${detail}`);
        }
      }
    }

    const clients: Client[] = [];
    const sockets = new Set<net.Socket>();
    const servers: net.Server[] = [];
    let info: TunnelInfo | undefined;
    let abortSetup: ((err: Error) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abortSetup = reject;
    });
    aborted.catch(() => {});
    const handleDrop = () => {
      if (info) {
        if (this.tunnels.get(connectionId) !== info) {
          return;
        }
        this.logger.warn(`[${connectionId}] SSH tunnel dropped; tearing it down`);
        this.teardownInfo(connectionId, info);
        params.onUnexpectedClose?.();
      } else {
        // Dropped mid-setup, before registration: abort createTunnel.
        abortSetup?.(
          new Error(`SSH connection for ${connectionId} dropped during tunnel setup`),
        );
      }
    };

    try {
      for (let i = 0; i < hops.length; i++) {
        const hop = hops[i];
        let sock: any | undefined;
        if (i > 0) {
          try {
            sock = await Promise.race([
              aborted,
              this.forwardOutPromise(clients[i - 1], hop.sshHost, hop.sshPort),
            ]);
          } catch (err) {
            throw new Error(
              `Connected to ${hops[i - 1].sshHost}, but ${hop.sshHost}:${hop.sshPort} refused the connection`,
            );
          }
          if (sock && typeof sock.on === 'function') {
            const targetHost = hop.sshHost;
            const targetPort = hop.sshPort;
            sock.on('error', () => {
              if (info) {
                handleDrop();
              } else {
                abortSetup?.(
                  new Error(`SSH chain link to ${targetHost}:${targetPort} failed`),
                );
              }
            });
          }
        }
        const client = await Promise.race([
          aborted,
          this.connectOneHop(connectionId, hop, sock, params.onHostKey),
        ]);
        clients.push(client);
        client.on('error', handleDrop);
        client.on('close', handleDrop);
      }
      const lastClient = clients[clients.length - 1];

      // Pre-flight: verify the remote database port is reachable through the hop
      // before we expose a local listener, so bad host/port fails fast.
      await Promise.race([
        aborted,
        new Promise<void>((resolve, reject) => {
          lastClient.forwardOut('127.0.0.1', 0, params.remoteHost, params.remotePort, (err, stream) => {
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
        }),
      ]);

      const { server, localPort } = await this.listenForwarded(
        connectionId,
        lastClient,
        sockets,
        params.remoteHost,
        params.remotePort,
        aborted,
        (s) => {
          servers.push(s);
        },
      );
      void server;

      info = {
        clients,
        servers,
        localPort,
        sockets,
        nodePorts: new Map(),
        nodeServers: new Map(),
        nodeForwardInflight: new Map(),
        nodeSockets: new Map(),
        nodeTombstones: new Set(),
      };
      this.tunnels.set(connectionId, info);
      this.logger.log(`[${connectionId}] SSH tunnel listening on 127.0.0.1:${localPort}`);
      return localPort;
    } catch (err) {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      for (const server of servers) {
        server.close();
      }
      for (const client of clients) {
        client.end();
      }
      throw err;
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      // Let the process exit naturally while only this timer is pending.
      timer.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /** Open an additional loopback forward through the chain to `remoteHost:remotePort`. */
  async createNodeForward(
    connectionId: string,
    remoteHost: string,
    remotePort: number,
  ): Promise<number> {
    const info = this.tunnels.get(connectionId);
    if (!info || info.clients.length === 0) {
      throw new Error('SSH tunnel is not established; reconnect the connection before dialling nodes.');
    }
    const key = `${remoteHost}:${remotePort}`;
    const cached = info.nodePorts.get(key);
    if (cached !== undefined) {
      if (!info.nodeTombstones.has(key)) {
        return cached;
      }
      info.nodePorts.delete(key);
      info.nodeTombstones.delete(key);
    }
    const inflight = info.nodeForwardInflight.get(key);
    if (inflight) {
      return inflight;
    }
    if (info.nodePorts.size + info.nodeForwardInflight.size >= SSH_MAX_NODE_FORWARDS) {
      throw new Error(
        `Too many SSH node forwards (${info.nodePorts.size}); refusing ${key}`,
      );
    }
    const task = this.doCreateNodeForward(connectionId, info, remoteHost, remotePort, key);
    info.nodeForwardInflight.set(key, task);
    try {
      return await task;
    } finally {
      info.nodeForwardInflight.delete(key);
      if (info.nodeTombstones.has(key)) {
        info.nodeTombstones.delete(key);
        const server = info.nodeServers.get(key);
        const sockSet = info.nodeSockets.get(key);
        if (sockSet) {
          for (const sock of sockSet) sock.destroy();
          sockSet.clear();
        }
        info.nodePorts.delete(key);
        info.nodeServers.delete(key);
        info.nodeSockets.delete(key);
        if (server) {
          const idx = info.servers.indexOf(server);
          if (idx >= 0) info.servers.splice(idx, 1);
          try {
            server.close();
          } catch {
            // Best-effort.
          }
        }
      }
    }
  }

  private async doCreateNodeForward(
    connectionId: string,
    info: TunnelInfo,
    remoteHost: string,
    remotePort: number,
    key: string,
  ): Promise<number> {
    const lastClient = info.clients[info.clients.length - 1];
    if (!lastClient) {
      throw new Error('SSH tunnel is not established; reconnect the connection before dialling nodes.');
    }
    const perNodeSockets = new Set<net.Socket>();
    info.nodeSockets.set(key, perNodeSockets);

    const doForward = async (): Promise<number> => {
      await this.forwardOutPromise(lastClient, remoteHost, remotePort).then(
        (stream: { end: () => void }) => {
          try {
            stream.end();
          } catch {
            // Best-effort probe cleanup.
          }
        },
        () => {
          throw new Error(
            `Connected to SSH server, but ${remoteHost}:${remotePort} refused the connection`,
          );
        },
      );
      const neverAborts = new Promise<never>(() => {});
      let nodeServer: net.Server | undefined;
      try {
        const { server, localPort } = await this.listenForwarded(
          connectionId,
          lastClient,
          info.sockets,
          remoteHost,
          remotePort,
          neverAborts,
          (s) => {
            nodeServer = s;
            info.servers.push(s);
          },
          perNodeSockets,
        );
        void server;
        if (this.tunnels.get(connectionId) !== info) {
          for (const sock of perNodeSockets) sock.destroy();
          perNodeSockets.clear();
          nodeServer?.close();
          const idx = nodeServer ? info.servers.indexOf(nodeServer) : -1;
          if (idx >= 0) info.servers.splice(idx, 1);
          info.nodeSockets.delete(key);
          throw new Error('SSH tunnel is not established; reconnect the connection before dialling nodes.');
        }
        if (info.nodeTombstones.has(key)) {
          for (const sock of perNodeSockets) sock.destroy();
          perNodeSockets.clear();
          nodeServer?.close();
          const idx = nodeServer ? info.servers.indexOf(nodeServer) : -1;
          if (idx >= 0) info.servers.splice(idx, 1);
          info.nodeSockets.delete(key);
          throw new Error(`SSH node forward for ${key} was evicted while being created`);
        }
        info.nodePorts.set(key, localPort);
        if (nodeServer) {
          info.nodeServers.set(key, nodeServer);
        }
        this.logger.log(`[${connectionId}] SSH node forward ${key} listening on 127.0.0.1:${localPort}`);
        return localPort;
      } catch (err) {
        if (nodeServer) {
          for (const sock of perNodeSockets) sock.destroy();
          perNodeSockets.clear();
          nodeServer.close();
          const idx = info.servers.indexOf(nodeServer);
          if (idx >= 0) info.servers.splice(idx, 1);
          info.nodeServers.delete(key);
          info.nodeSockets.delete(key);
        } else {
          info.nodeSockets.delete(key);
        }
        throw err;
      }
    };

    return this.withTimeout(
      doForward(),
      SSH_NODE_FORWARD_TIMEOUT_MS,
      `SSH node forward to ${key} timed out after ${SSH_NODE_FORWARD_TIMEOUT_MS}ms`,
    );
  }

  closeNodeForward(connectionId: string, remoteHost: string, remotePort: number): void {
    const info = this.tunnels.get(connectionId);
    if (!info) return;
    const key = `${remoteHost}:${remotePort}`;
    if (info.nodeForwardInflight.has(key)) {
      info.nodeTombstones.add(key);
      return;
    }
    const server = info.nodeServers.get(key);
    const sockSet = info.nodeSockets.get(key);
    if (sockSet) {
      for (const sock of sockSet) sock.destroy();
      sockSet.clear();
    }
    info.nodePorts.delete(key);
    info.nodeServers.delete(key);
    info.nodeSockets.delete(key);
    info.nodeTombstones.delete(key);
    if (server) {
      const idx = info.servers.indexOf(server);
      if (idx >= 0) info.servers.splice(idx, 1);
      try {
        server.close();
      } catch {
        // Best-effort.
      }
    }
  }

  private teardownInfo(connectionId: string, info: TunnelInfo): void {
    this.tunnels.delete(connectionId);
    for (const socket of info.sockets) {
      socket.destroy();
    }
    info.sockets.clear();
    for (const sockSet of info.nodeSockets.values()) {
      for (const sock of sockSet) sock.destroy();
      sockSet.clear();
    }
    info.nodeSockets.clear();
    info.nodeTombstones.clear();
    info.nodeForwardInflight.clear();
    for (const server of info.servers) {
      server.close();
    }
    for (const client of info.clients) {
      client.end();
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
    for (const sockSet of tunnel.nodeSockets.values()) {
      for (const sock of sockSet) sock.destroy();
      sockSet.clear();
    }
    tunnel.nodeSockets.clear();
    tunnel.nodeTombstones.clear();
    tunnel.nodeForwardInflight.clear();
    await Promise.all(
      tunnel.servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    for (const client of tunnel.clients) {
      client.end();
    }
  }

  async closeAll(): Promise<void> {
    const ids = [...this.tunnels.keys()];
    await Promise.all(ids.map((id) => this.closeTunnel(id)));
  }

  hasTunnel(connectionId: string): boolean {
    return this.tunnels.has(connectionId);
  }
}
