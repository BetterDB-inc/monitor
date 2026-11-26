import Valkey from 'iovalkey';
import { isElastiCacheServerlessHost } from '@betterdb/shared';
import type { AgentIdentity } from '@betterdb/shared';
import { WsClient } from './ws-client';
import { CommandExecutor } from './command-executor';
import { valkeyTlsOptions, ValkeyTlsMaterial } from './valkey-tls';
import type { AgentCommandMessage, AgentHelloMessage, AgentWelcomeMessage } from './protocol';
import type { AuthProvider } from './auth';
import { PasswordProvider, ElastiCacheIamProvider } from './auth';

export interface AgentConfig {
  token: string;
  cloudUrl: string;
  valkeyHost: string;
  valkeyPort: number;
  valkeyUsername: string;
  valkeyPassword: string;
  valkeyTls: boolean;
  valkeyDb: number;
  unsafeMode: boolean;
  // New IAM auth fields. authMode defaults to "password" so existing setups
  // are unaffected.
  authMode?: 'password' | 'elasticache-iam';
  awsRegion?: string;
  awsResourceName?: string;
  awsUserId?: string;
  awsServerless?: boolean;
  /** TLS material for the Valkey connection, used when valkeyTls is on (see ValkeyTlsMaterial). */
  valkeyTlsOptions?: ValkeyTlsMaterial;
  /** Sent in the hello; identifies this target when one process relays many. */
  identity?: AgentIdentity;
  /** Sent in the hello; asks the cloud to refuse state-changing commands. */
  readOnly?: boolean;
  /** Extra CA (PEM) to trust for the cloud WebSocket, e.g. a self-hosted Monitor behind a private CA. */
  cloudCa?: string;
  /** Prefix for log lines, so the targets of a multi-target process can be told apart. */
  logPrefix?: string;
  /**
   * The target is a cluster replica: send READONLY on every (re)connect so
   * keyed reads (key sampling, MEMORY USAGE) are served instead of answered
   * with MOVED.
   */
  clusterReplica?: boolean;
}

async function boundedQuit(client: Valkey): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, QUIT_TIMEOUT_MS); });
  await Promise.race([client.quit().then(() => undefined, () => undefined), deadline]);
  clearTimeout(timer);
}

/** The first Monitor release that understands identified (multi-target) agents. */
export const MIN_MONITOR_VERSION = '0.57.0';
export const LEGACY_SERVER_MESSAGE =
  `BetterDB server too old: identified agents need Monitor ${MIN_MONITOR_VERSION} or later, or BetterDB Cloud`;
// How long after the hello a server that understands identities has to say so.
const WELCOME_TIMEOUT_MS = 15_000;
export const NO_WELCOME_MESSAGE =
  `BetterDB did not acknowledge this node within ${WELCOME_TIMEOUT_MS / 1000} s, reconnecting ` +
  `(a Monitor older than ${MIN_MONITOR_VERSION} never does)`;
// A node that accepts the connection but never answers INFO must not hang
// start() (and whoever awaits it) forever.
const STARTUP_TIMEOUT_MS = 15_000;
// quit() waits for the pending queue; during an outage that can be minutes,
// so stop() gives it this long before disconnecting outright.
const QUIT_TIMEOUT_MS = 2_000;

export class Agent {
  private client: Valkey | null = null;
  private executor: CommandExecutor | null = null;
  private cliClient: Valkey | null = null;
  private readonly authProvider: AuthProvider;
  private shuttingDown = false;
  private started = false;
  private isReconnecting = false;
  private reconnectAttempt = 0;
  private reconnectLoopPromise: Promise<void> | null = null;
  private resolveReconnectDelay: (() => void) | null = null;
  private readonly shutdownSignal: Promise<void>;
  private resolveShutdown!: () => void;
  private cliExecutor: CommandExecutor | null = null;
  private cliConnectingPromise: Promise<CommandExecutor> | null = null;
  private wsClient: WsClient;
  private valkeyConnected = false;
  private valkeyType: 'valkey' | 'redis' = 'valkey';
  private valkeyVersion = 'unknown';
  private isCluster = false;
  private capabilities: string[] = [];
  private readonly tag: string;
  // Set when the cloud side cannot carry this target: a server too old to
  // understand identities, or another agent already streaming this node.
  private cloudError: string | undefined;
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null;

  private executorOptions(): { unsafeMode: boolean; readOnly: boolean } {
    return { unsafeMode: this.config.unsafeMode, readOnly: this.config.readOnly === true };
  }

  private async createValkeyClient(connectionName: string): Promise<Valkey> {
    const result = await Promise.race([
      this.authProvider.getToken().then(t => ({ token: t, shutdown: false as const })),
      this.shutdownSignal.then(() => ({ token: '', shutdown: true as const })),
    ]);
    if (result.shutdown) {
      throw new Error('agent shutting down');
    }
    const password = result.token;
    // For IAM modes we disable iovalkey's internal reconnect because each
    // reconnect must use a fresh token. The Agent rebuilds the client on close.
    const retryStrategy = this.authProvider.requiresFreshTokenPerConnection
      ? () => null
      : (times: number) => Math.min(times * 1000, 30000);

    return new Valkey({
      host: this.config.valkeyHost,
      port: this.config.valkeyPort,
      username: this.config.valkeyUsername,
      password,
      tls: this.config.valkeyTls ? valkeyTlsOptions(this.config.valkeyTlsOptions) : undefined,
      db: this.config.valkeyDb,
      lazyConnect: true,
      connectionName,
      // iovalkey sends READONLY on every connect, including its reconnects.
      readOnly: this.config.clusterReplica === true,
      retryStrategy,
    });
  }

  private buildAuthProvider(): AuthProvider {
    if (this.config.authMode === 'elasticache-iam') {
      return new ElastiCacheIamProvider({
        region: this.config.awsRegion!,
        resourceName: this.config.awsResourceName!,
        userId: this.config.awsUserId!,
        serverless: this.config.awsServerless,
      });
    }
    return new PasswordProvider(this.config.valkeyPassword);
  }

  private attachClientHandlers(client: Valkey): void {
    client.on('connect', () => {
      this.valkeyConnected = true;
      console.log(`${this.tag} Connected to Valkey/Redis`);
    });

    client.on('error', (err) => {
      console.error(`${this.tag} Valkey error: ${err.message}`);
      this.valkeyConnected = false;
      // In IAM mode, trigger a fresh-token reconnect on auth rejections (WRONGPASS /
      // NOAUTH) that don't emit a subsequent close. Transient network errors
      // (ECONNRESET, ETIMEDOUT) are handled by the close handler below, since
      // iovalkey emits close after error in those cases.
      const isAuthError = /WRONGPASS|NOAUTH/i.test(err.message);
      if (this.started && !this.shuttingDown && this.authProvider.requiresFreshTokenPerConnection && isAuthError && !this.isReconnecting) {
        this.reconnectLoopPromise = this.reconnectWithFreshToken().catch((reconnectErr) => {
          console.error(`${this.tag} IAM reconnect failed: ${reconnectErr.message}`);
        });
      }
    });

    client.on('close', () => {
      this.valkeyConnected = false;
      if (this.shuttingDown) return;
      if (this.started && this.authProvider.requiresFreshTokenPerConnection && !this.isReconnecting) {
        this.reconnectLoopPromise = this.reconnectWithFreshToken().catch((err) => {
          console.error(`${this.tag} IAM reconnect failed: ${err.message}`);
        });
      }
    });
  }

  private async reconnectWithFreshToken(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.isReconnecting) return;
    this.isReconnecting = true;

    this.reconnectAttempt += 1;
    const delayMs = Math.min(this.reconnectAttempt * 1000, 30000);
    console.log(`${this.tag} Rebuilding Valkey client with fresh IAM token (attempt ${this.reconnectAttempt}, delay ${delayMs}ms)`);
    await new Promise<void>((resolve) => {
      this.resolveReconnectDelay = resolve;
      setTimeout(() => { this.resolveReconnectDelay = null; resolve(); }, delayMs);
    });
    this.resolveReconnectDelay = null;

    if (this.shuttingDown) {
      this.isReconnecting = false;
      return;
    }

    try {
      if (this.client) {
        this.client.removeAllListeners();
        try { this.client.disconnect(); } catch { /* ignore */ }
      }
      // Proactively tear down CLI client so both connections rotate together.
      // Null cliConnectingPromise unconditionally: if a CLI creation is in-flight
      // with the old token, its result is discarded so the next getCliExecutor
      // call starts a fresh connection rather than awaiting the stale promise.
      this.cliConnectingPromise = null;
      if (this.cliClient) {
        this.cliClient.removeAllListeners();
        try { this.cliClient.disconnect(); } catch { /* ignore */ }
        this.cliClient = null;
        this.cliExecutor = null;
      }
      this.client = await this.createValkeyClient('BetterDB-Agent');
      this.attachClientHandlers(this.client);
      // Assign executor before connect() so any WS command that arrives in the
      // same tick as the 'connect' event dispatches to the live client.
      this.executor = new CommandExecutor(this.client, this.executorOptions());
      await this.client.connect();
      // Mirror start(): explicitly set the flag so commands aren't rejected
      // if the 'connect' event fires in a deferred tick.
      this.valkeyConnected = true;
      // Guard against stop() racing with the connect above.
      if (this.shuttingDown) {
        await this.client.quit().catch(() => {});
        this.isReconnecting = false;
        return;
      }
      this.reconnectAttempt = 0;
      this.isReconnecting = false;
      this.reconnectLoopPromise = null;
    } catch (err: any) {
      console.error(`${this.tag} Failed to reconnect with fresh token: ${err.message}`);
      this.isReconnecting = false;
      if (!this.shuttingDown) {
        // Intentional: perpetual retry loop. Per-iteration errors are logged above;
        // the outer .catch(() => {}) suppresses unhandled-rejection noise.
        this.reconnectLoopPromise = this.reconnectWithFreshToken().catch(() => {});
      }
    }
  }

  constructor(private readonly config: AgentConfig) {
    this.tag = config.logPrefix ?? '[Agent]';
    this.authProvider = this.buildAuthProvider();
    this.shutdownSignal = new Promise<void>(resolve => { this.resolveShutdown = resolve; });

    if (config.unsafeMode) {
      console.warn(`${this.tag} WARNING: Unsafe mode enabled. All commands are permitted.`);
    }

    this.wsClient = new WsClient({
      url: config.cloudUrl,
      token: config.token,
      ca: config.cloudCa,
      logPrefix: this.tag,
      onOpen: () => this.onWsOpen(),
      onMessage: (data) => this.onWsMessage(data),
      onClose: (code, reason) => this.onWsClose(code, reason),
      onError: (err) => console.error(`${this.tag} WS error: ${err.message}`),
    });
  }

  /** Live state for status pages: whether both ends of the relay are up. */
  getStatus(): { valkeyConnected: boolean; cloudConnected: boolean; valkeyVersion: string; cluster: boolean; cloudError?: string } {
    return {
      valkeyConnected: this.valkeyConnected,
      cloudConnected: this.wsClient.isOpen() && this.cloudError === undefined,
      valkeyVersion: this.valkeyVersion,
      cluster: this.isCluster,
      ...(this.cloudError !== undefined ? { cloudError: this.cloudError } : {}),
    };
  }

  async start(): Promise<void> {
    console.log(`${this.tag} Connecting to ${this.config.valkeyHost}:${this.config.valkeyPort}...`);
    try {
      this.client = await this.createValkeyClient('BetterDB-Agent');
      this.attachClientHandlers(this.client);
      this.executor = new CommandExecutor(this.client, this.executorOptions());
      await this.withStartupDeadline(this.client.connect(), 'connect');
      this.valkeyConnected = true;

      await this.withStartupDeadline(this.detectCapabilities(), 'capability detection');
      console.log(`${this.tag} Detected ${this.valkeyType} ${this.valkeyVersion}`);
      // Mark fully started only after capability detection finishes. Error/close
      // handlers gate their reconnect path on this.started, so any disconnect
      // during detectCapabilities() is also ignored — the catch block handles it.
      this.started = true;

      console.log(`${this.tag} Connecting to cloud: ${this.config.cloudUrl}`);
      this.wsClient.connect();
    } catch (err) {
      // Agent is single-use: a failed start() is not recoverable on the same
      // instance. Callers should discard this instance and create a new one.
      this.shuttingDown = true;
      try { this.client?.disconnect(); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * Bounds a startup step: it fails after STARTUP_TIMEOUT_MS, and at once when
   * stop() is called meanwhile, so a silent node cannot hold start() open.
   */
  private withStartupDeadline<T>(step: Promise<T>, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what} timed out after ${STARTUP_TIMEOUT_MS}ms`)), STARTUP_TIMEOUT_MS);
      const stopped = this.shutdownSignal.then(() => { throw new Error(`agent stopped during ${what}`); });
      Promise.race([step, stopped]).then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    this.resolveShutdown();
    console.log(`${this.tag} Shutting down...`);
    this.wsClient.close();
    this.clearWelcomeTimer();
    // If the reconnect loop is sleeping in its backoff delay, wake it immediately
    // so it can observe shuttingDown and exit rather than blocking stop() for up to 30s.
    if (this.resolveReconnectDelay) {
      this.resolveReconnectDelay();
      this.resolveReconnectDelay = null;
    }
    // If reconnectWithFreshToken is blocked on client.connect(), abort it so
    // stop() doesn't stall until TCP timeout. The resulting rejection is caught
    // by reconnectWithFreshToken's catch block, which skips retry on shuttingDown.
    if (this.isReconnecting && this.client) {
      try { this.client.disconnect(); } catch { /* ignore */ }
    }
    while (this.reconnectLoopPromise) {
      const current = this.reconnectLoopPromise;
      await current;
      // A resolved Promise is still truthy. If a new iteration was scheduled,
      // reconnectLoopPromise was overwritten with a fresh reference — loop again.
      // If not (shuttingDown stopped the loop), clear the stale reference to exit.
      if (this.reconnectLoopPromise === current) {
        this.reconnectLoopPromise = null;
      }
    }
    // Quit politely when connected, for a bounded time, then disconnect
    // regardless: a client that never connected or is mid-reconnect would
    // otherwise keep retrying forever, and quit() on one waits for its queue.
    if (this.cliClient) {
      if (this.cliClient.status === 'ready') await boundedQuit(this.cliClient);
      try { this.cliClient.disconnect(); } catch { /* ignore */ }
    }
    if (this.client) {
      if (this.valkeyConnected) await boundedQuit(this.client);
      try { this.client.disconnect(); } catch { /* ignore */ }
    }
    console.log(`${this.tag} Stopped`);
  }

  private async detectCapabilities(): Promise<void> {
    const infoStr = (await this.client!.info('server')) as string;
    const isValkey = infoStr.includes('valkey_version:');
    this.valkeyType = isValkey ? 'valkey' : 'redis';

    const versionMatch = isValkey
      ? infoStr.match(/valkey_version:(\S+)/)
      : infoStr.match(/redis_version:(\S+)/);
    this.valkeyVersion = versionMatch?.[1] || 'unknown';

    // Check cluster. cluster_enabled is in INFO's cluster section; CLUSTER
    // INFO never carries it, so reading it there reported every server as
    // standalone and the CLUSTER capability was never advertised.
    try {
      const clusterSection = (await this.client!.info('cluster')) as string;
      this.isCluster = /cluster_enabled:1/.test(clusterSection);
    } catch {
      this.isCluster = false;
    }

    // Build capabilities list
    this.capabilities = [
      'PING',
      'INFO',
      'DBSIZE',
      'SLOWLOG',
      'CLIENT',
      'ACL',
      'CONFIG',
      'MEMORY',
      'LATENCY',
      'ROLE',
      'LASTSAVE',
      'COMMAND',
      'KEY_ANALYTICS',
    ];

    if (isValkey) {
      const major = parseInt(this.valkeyVersion.split('.')[0] || '0', 10);
      const minor = parseInt(this.valkeyVersion.split('.')[1] || '0', 10);
      if (major > 8 || (major === 8 && minor >= 1)) {
        this.capabilities.push('COMMANDLOG');
      }
    }

    if (this.isCluster) {
      this.capabilities.push('CLUSTER');
    }

    // Detect FT (Search) module
    try {
      await this.client!.call('FT._LIST');
      this.capabilities.push('FT');
    } catch {
      // Search module not loaded
    }
  }

  private onWsOpen(): void {
    console.log(`${this.tag} WebSocket connected, sending hello`);
    const hello: AgentHelloMessage = {
      type: 'agent_hello',
      version: '0.1.0',
      capabilities: this.capabilities,
      valkey: {
        type: this.valkeyType,
        version: this.valkeyVersion,
        tls: this.config.valkeyTls,
        cluster: this.isCluster,
        serverless: (this.config.awsServerless ?? false) || isElastiCacheServerlessHost(this.config.valkeyHost),
      },
      authMode: this.authProvider.mode,
    };
    if (this.config.identity) hello.identity = this.config.identity;
    if (this.config.readOnly) hello.readOnly = true;
    this.wsClient.send(JSON.stringify(hello));
    // An identified hello needs the server to say it understood the identity.
    // A server from before AgentWelcomeMessage never does, but neither does a
    // busy or restarting Monitor in time, so a missing welcome only drops this
    // socket and lets the reconnect backoff try again. Giving up for good is
    // left to a welcome that disowns the identity.
    if (this.config.identity) {
      this.clearWelcomeTimer();
      this.welcomeTimer = setTimeout(() => this.retryWithoutWelcome(), WELCOME_TIMEOUT_MS);
    }
  }

  private retryWithoutWelcome(): void {
    this.welcomeTimer = null;
    this.cloudError = NO_WELCOME_MESSAGE;
    console.warn(`${this.tag} ${NO_WELCOME_MESSAGE}`);
    this.wsClient.dropConnection(4000, 'Welcome timeout');
  }

  private onWelcome(msg: AgentWelcomeMessage): void {
    this.clearWelcomeTimer();
    if (this.config.identity && msg.identity !== true) {
      this.giveUpOnCloud(LEGACY_SERVER_MESSAGE);
      return;
    }
    this.cloudError = undefined;
  }

  private onWsClose(code: number, reason: string): void {
    console.log(`${this.tag} WS closed: ${code} ${reason}`);
    this.clearWelcomeTimer();
    // 4003: the server kept another connection for this id. For an identified
    // node that is a second agent on the same instance; the reconnect loop
    // keeps trying at its slowest pace, and the status says why.
    if (code === 4003 && this.config.identity) {
      this.cloudError = `another agent already streams this node (BetterDB closed the connection with ${code})`;
    }
  }

  private giveUpOnCloud(message: string): void {
    this.cloudError = message;
    console.error(`${this.tag} ${message}`);
    this.wsClient.close();
  }

  private clearWelcomeTimer(): void {
    if (this.welcomeTimer) {
      clearTimeout(this.welcomeTimer);
      this.welcomeTimer = null;
    }
  }

  private async onWsMessage(data: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      console.error(`${this.tag} Invalid JSON from cloud`);
      return;
    }

    if (msg.type === 'ping') {
      this.wsClient.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
      return;
    }

    if (msg.type === 'welcome') {
      this.onWelcome(msg as AgentWelcomeMessage);
      return;
    }

    if (msg.type === 'command') {
      await this.handleCommand(msg as AgentCommandMessage);
    }
  }

  private async getCliExecutor(): Promise<CommandExecutor> {
    if (this.cliExecutor && this.cliClient) {
      return this.cliExecutor;
    }
    // Deduplicate concurrent calls: return the in-progress creation promise
    // so two overlapping WS commands don't each allocate a separate CLI client.
    if (this.cliConnectingPromise) {
      return this.cliConnectingPromise;
    }
    this.cliConnectingPromise = (async () => {
      const client = await this.createValkeyClient('BetterDB-Agent-CLI');
      this.cliClient = client;
      client.on('close', () => {
        // With a static password iovalkey reconnects this client itself, so
        // the reference stays (and stop() can disconnect it). An IAM client
        // cannot reconnect without a fresh token: drop it, the next CLI
        // command builds a new one.
        if (this.cliClient === client && this.authProvider.requiresFreshTokenPerConnection) {
          try { client.disconnect(); } catch { /* ignore */ }
          this.cliClient = null;
          this.cliExecutor = null;
        }
      });
      await client.connect();
      // If reconnectWithFreshToken ran while we were connecting, it will have
      // nulled this.cliClient. Throw so the stale connection is discarded rather
      // than installing a broken executor.
      if (this.cliClient !== client) {
        client.quit().catch(() => {});
        throw new Error('CLI connection invalidated by IAM rotation');
      }
      this.cliExecutor = new CommandExecutor(client, this.executorOptions());
      console.log(`${this.tag} CLI client connected`);
      return this.cliExecutor;
    })().finally(() => {
      this.cliConnectingPromise = null;
    });
    return this.cliConnectingPromise;
  }

  private async handleCommand(msg: AgentCommandMessage): Promise<void> {
    if (!this.valkeyConnected) {
      this.wsClient.send(
        JSON.stringify({
          id: msg.id,
          type: 'error',
          error: 'Valkey connection unavailable',
        }),
      );
      return;
    }

    try {
      // Decode base64 binaryArgs to Buffers
      let binaryArgs: Record<string, Buffer> | undefined;
      if (msg.binaryArgs) {
        binaryArgs = {};
        for (const [key, val] of Object.entries(msg.binaryArgs)) {
          binaryArgs[key] = Buffer.from(val, 'base64');
        }
      }

      const executor = msg.cli ? await this.getCliExecutor() : this.executor;
      if (!executor) {
        throw new Error('Executor not ready');
      }
      const result = await executor.execute(msg.cmd, msg.args, binaryArgs);

      // If result is a Buffer, encode as base64 and flag as binary
      if (Buffer.isBuffer(result)) {
        this.wsClient.send(
          JSON.stringify({
            id: msg.id,
            type: 'response',
            data: result.toString('base64'),
            binary: true,
          }),
        );
      } else {
        this.wsClient.send(
          JSON.stringify({
            id: msg.id,
            type: 'response',
            data: result,
          }),
        );
      }
    } catch (err: any) {
      this.wsClient.send(
        JSON.stringify({
          id: msg.id,
          type: 'error',
          error: err.message || 'Command execution failed',
        }),
      );
    }
  }
}
