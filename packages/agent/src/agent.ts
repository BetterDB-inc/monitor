import Valkey from 'iovalkey';
import { WsClient } from './ws-client';
import { CommandExecutor } from './command-executor';
import type { AgentCommandMessage, AgentHelloMessage } from './protocol';
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
}

export class Agent {
  private client: Valkey | null = null;
  private executor: CommandExecutor | null = null;
  private cliClient: Valkey | null = null;
  private readonly authProvider: AuthProvider;
  private shuttingDown = false;
  private isReconnecting = false;
  private reconnectAttempt = 0;
  private reconnectLoopPromise: Promise<void> | null = null;
  private resolveReconnectDelay: (() => void) | null = null;
  private cliExecutor: CommandExecutor | null = null;
  private cliConnectingPromise: Promise<CommandExecutor> | null = null;
  private wsClient: WsClient;
  private valkeyConnected = false;
  private valkeyType: 'valkey' | 'redis' = 'valkey';
  private valkeyVersion = 'unknown';
  private isCluster = false;
  private capabilities: string[] = [];

  private async createValkeyClient(connectionName: string): Promise<Valkey> {
    const password = await this.authProvider.getToken();
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
      tls: this.config.valkeyTls ? {} : undefined,
      db: this.config.valkeyDb,
      lazyConnect: true,
      connectionName,
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
      console.log('[Agent] Connected to Valkey/Redis');
    });

    client.on('error', (err) => {
      console.error(`[Agent] Valkey error: ${err.message}`);
      this.valkeyConnected = false;
      // In IAM mode, trigger a fresh-token reconnect on auth rejections (WRONGPASS /
      // NOAUTH) that don't emit a subsequent close. Transient network errors
      // (ECONNRESET, ETIMEDOUT) are handled by the close handler below, since
      // iovalkey emits close after error in those cases.
      const isAuthError = /WRONGPASS|NOAUTH/i.test(err.message);
      if (!this.shuttingDown && this.authProvider.requiresFreshTokenPerConnection && isAuthError && !this.isReconnecting) {
        this.reconnectLoopPromise = this.reconnectWithFreshToken().catch((reconnectErr) => {
          console.error(`[Agent] IAM reconnect failed: ${reconnectErr.message}`);
        });
      }
    });

    client.on('close', () => {
      this.valkeyConnected = false;
      if (this.shuttingDown) return;
      if (this.authProvider.requiresFreshTokenPerConnection && !this.isReconnecting) {
        this.reconnectLoopPromise = this.reconnectWithFreshToken().catch((err) => {
          console.error(`[Agent] IAM reconnect failed: ${err.message}`);
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
    console.log(`[Agent] Rebuilding Valkey client with fresh IAM token (attempt ${this.reconnectAttempt}, delay ${delayMs}ms)`);
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
      this.executor = new CommandExecutor(this.client, { unsafeMode: this.config.unsafeMode });
      await this.client.connect();
      // Guard against stop() racing with the connect above.
      if (this.shuttingDown) {
        await this.client.quit().catch(() => {});
        this.isReconnecting = false;
        return;
      }
      this.reconnectAttempt = 0;
      this.isReconnecting = false;
    } catch (err: any) {
      console.error(`[Agent] Failed to reconnect with fresh token: ${err.message}`);
      this.isReconnecting = false;
      if (!this.shuttingDown) {
        // Intentional: perpetual retry loop. Per-iteration errors are logged above;
        // the outer .catch(() => {}) suppresses unhandled-rejection noise.
        this.reconnectLoopPromise = this.reconnectWithFreshToken().catch(() => {});
      }
    }
  }

  constructor(private readonly config: AgentConfig) {
    this.authProvider = this.buildAuthProvider();

    if (config.unsafeMode) {
      console.warn('[Agent] WARNING: Unsafe mode enabled. All commands are permitted.');
    }

    this.wsClient = new WsClient({
      url: config.cloudUrl,
      token: config.token,
      onOpen: () => this.onWsOpen(),
      onMessage: (data) => this.onWsMessage(data),
      onClose: (code, reason) => console.log(`[Agent] WS closed: ${code} ${reason}`),
      onError: (err) => console.error(`[Agent] WS error: ${err.message}`),
    });
  }

  async start(): Promise<void> {
    console.log(`[Agent] Connecting to ${this.config.valkeyHost}:${this.config.valkeyPort}...`);
    try {
      this.client = await this.createValkeyClient('BetterDB-Agent');
      this.attachClientHandlers(this.client);
      this.executor = new CommandExecutor(this.client, { unsafeMode: this.config.unsafeMode });
      await this.client.connect();
      this.valkeyConnected = true;

      await this.detectCapabilities();
      console.log(`[Agent] Detected ${this.valkeyType} ${this.valkeyVersion}`);

      console.log(`[Agent] Connecting to cloud: ${this.config.cloudUrl}`);
      this.wsClient.connect();
    } catch (err) {
      // Agent is single-use: a failed start() is not recoverable on the same
      // instance. Setting shuttingDown prevents the error handler from spawning
      // a reconnect loop. Callers should discard this instance and create a new one.
      this.shuttingDown = true;
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    console.log('[Agent] Shutting down...');
    this.wsClient.close();
    // If the reconnect loop is sleeping in its backoff delay, wake it immediately
    // so it can observe shuttingDown and exit rather than blocking stop() for up to 30s.
    if (this.resolveReconnectDelay) {
      this.resolveReconnectDelay();
      this.resolveReconnectDelay = null;
    }
    while (this.reconnectLoopPromise) {
      await this.reconnectLoopPromise;
    }
    if (this.cliClient) {
      await this.cliClient.quit().catch(() => {});
    }
    if (this.valkeyConnected) {
      await this.client?.quit().catch(() => {});
    }
    console.log('[Agent] Stopped');
  }

  private async detectCapabilities(): Promise<void> {
    const infoStr = (await this.client!.info('server')) as string;
    const isValkey = infoStr.includes('valkey_version:');
    this.valkeyType = isValkey ? 'valkey' : 'redis';

    const versionMatch = isValkey
      ? infoStr.match(/valkey_version:(\S+)/)
      : infoStr.match(/redis_version:(\S+)/);
    this.valkeyVersion = versionMatch?.[1] || 'unknown';

    // Check cluster
    try {
      const clusterInfo = (await this.client!.call('CLUSTER', 'INFO')) as string;
      this.isCluster = clusterInfo.includes('cluster_enabled:1');
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
    console.log('[Agent] WebSocket connected, sending hello');
    const hello: AgentHelloMessage = {
      type: 'agent_hello',
      version: '0.1.0',
      capabilities: this.capabilities,
      valkey: {
        type: this.valkeyType,
        version: this.valkeyVersion,
        tls: this.config.valkeyTls,
        cluster: this.isCluster,
      },
      authMode: this.authProvider.mode,
    };
    this.wsClient.send(JSON.stringify(hello));
  }

  private async onWsMessage(data: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      console.error('[Agent] Invalid JSON from cloud');
      return;
    }

    if (msg.type === 'ping') {
      this.wsClient.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
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
        this.cliClient = null;
        this.cliExecutor = null;
      });
      await client.connect();
      // If reconnectWithFreshToken ran while we were connecting, it will have
      // nulled this.cliClient. Throw so the stale connection is discarded rather
      // than installing a broken executor.
      if (this.cliClient !== client) {
        client.quit().catch(() => {});
        throw new Error('CLI connection invalidated by IAM rotation');
      }
      this.cliExecutor = new CommandExecutor(client, { unsafeMode: this.config.unsafeMode });
      console.log('[Agent] CLI client connected');
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
