import Valkey from 'iovalkey';
import { WsClient } from './ws-client';
import { CommandExecutor } from './command-executor';
import type { AgentCommandMessage, AgentHelloMessage } from './protocol';

export interface AgentConfig {
  token: string;
  cloudUrl: string;
  valkeyHost: string;
  valkeyPort: number;
  valkeyUsername: string;
  valkeyPassword: string;
  valkeyTls: boolean;
  valkeyDb: number;
}

export class Agent {
  private client: Valkey;
  private executor: CommandExecutor;
  private wsClient: WsClient;
  private valkeyConnected = false;
  private valkeyType: 'valkey' | 'redis' = 'valkey';
  private valkeyVersion = 'unknown';
  private isCluster = false;
  private capabilities: string[] = [];

  constructor(private readonly config: AgentConfig) {
    this.client = new Valkey({
      host: config.valkeyHost,
      port: config.valkeyPort,
      username: config.valkeyUsername,
      password: config.valkeyPassword,
      tls: config.valkeyTls ? {} : undefined,
      db: config.valkeyDb,
      lazyConnect: true,
      connectionName: 'BetterDB-Agent',
      retryStrategy: (times: number) => Math.min(times * 1000, 30000),
    });

    this.executor = new CommandExecutor(this.client);

    this.client.on('connect', () => {
      this.valkeyConnected = true;
      console.log('[Agent] Connected to Valkey/Redis');
    });

    this.client.on('error', (err) => {
      console.error(`[Agent] Valkey error: ${err.message}`);
      this.valkeyConnected = false;
    });

    this.client.on('close', () => {
      this.valkeyConnected = false;
    });

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
    await this.client.connect();
    this.valkeyConnected = true;

    await this.detectCapabilities();
    console.log(`[Agent] Detected ${this.valkeyType} ${this.valkeyVersion}`);

    console.log(`[Agent] Connecting to cloud: ${this.config.cloudUrl}`);
    this.wsClient.connect();
  }

  async stop(): Promise<void> {
    console.log('[Agent] Shutting down...');
    this.wsClient.close();
    if (this.valkeyConnected) {
      await this.client.quit().catch(() => {});
    }
    console.log('[Agent] Stopped');
  }

  private async detectCapabilities(): Promise<void> {
    const infoStr = await this.client.info('server') as string;
    const isValkey = infoStr.includes('valkey_version:');
    this.valkeyType = isValkey ? 'valkey' : 'redis';

    const versionMatch = isValkey
      ? infoStr.match(/valkey_version:(\S+)/)
      : infoStr.match(/redis_version:(\S+)/);
    this.valkeyVersion = versionMatch?.[1] || 'unknown';

    // Check cluster
    try {
      const clusterInfo = await this.client.call('CLUSTER', 'INFO') as string;
      this.isCluster = clusterInfo.includes('cluster_enabled:1');
    } catch {
      this.isCluster = false;
    }

    // Build capabilities list
    this.capabilities = ['PING', 'INFO', 'DBSIZE', 'SLOWLOG', 'CLIENT', 'ACL',
      'CONFIG', 'MEMORY', 'LATENCY', 'ROLE', 'LASTSAVE', 'COMMAND', 'KEY_ANALYTICS'];

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

  private async handleCommand(msg: AgentCommandMessage): Promise<void> {
    if (!this.valkeyConnected) {
      this.wsClient.send(JSON.stringify({
        id: msg.id,
        type: 'error',
        error: 'Valkey connection unavailable',
      }));
      return;
    }

    try {
      const result = await this.executor.execute(msg.cmd, msg.args);
      this.wsClient.send(JSON.stringify({
        id: msg.id,
        type: 'response',
        data: result,
      }));
    } catch (err: any) {
      this.wsClient.send(JSON.stringify({
        id: msg.id,
        type: 'error',
        error: err.message || 'Command execution failed',
      }));
    }
  }
}
