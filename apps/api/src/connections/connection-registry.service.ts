import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { ConnectionStatus, CreateConnectionRequest, TestConnectionResponse, DatabaseConnectionConfig } from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { DatabasePort } from '../common/interfaces/database-port.interface';
import { UnifiedDatabaseAdapter } from '../database/adapters/unified.adapter';

const ENV_DEFAULT_ID = 'env-default';

@Injectable()
export class ConnectionRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConnectionRegistry.name);
  private connections = new Map<string, DatabasePort>();
  private configs = new Map<string, DatabaseConnectionConfig>();
  private defaultId: string | null = null;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadConnections();
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Shutting down connection registry...');
    const disconnectPromises: Promise<void>[] = [];

    for (const [id, client] of this.connections) {
      if (client.isConnected()) {
        disconnectPromises.push(
          client.disconnect()
            .then(() => this.logger.log(`Disconnected from ${id}`))
            .catch((error) => this.logger.error(`Error disconnecting ${id}: ${error instanceof Error ? error.message : error}`))
        );
      }
    }

    await Promise.allSettled(disconnectPromises);
    this.connections.clear();
    this.configs.clear();
    this.logger.log('Connection registry shut down complete');
  }

  private async loadConnections(): Promise<void> {
    const savedConnections = await this.storage.getConnections();

    if (savedConnections.length === 0) {
      await this.createEnvDefaultConnection();
    } else {
      for (const config of savedConnections) {
        this.configs.set(config.id, config);
        try {
          const adapter = this.createAdapter(config);
          await adapter.connect();
          this.connections.set(config.id, adapter);
          this.logger.log(`Connected to ${config.name} (${config.host}:${config.port})`);

          if (config.isDefault) {
            this.defaultId = config.id;
          }
        } catch (error) {
          this.logger.warn(`Failed to connect to ${config.name}: ${error instanceof Error ? error.message : error}`);
          // Still store the adapter even if connection failed - allows reconnection
          const adapter = this.createAdapter(config);
          this.connections.set(config.id, adapter);
        }
      }

      // Ensure we have a default
      if (!this.defaultId && savedConnections.length > 0) {
        this.defaultId = savedConnections[0].id;
        await this.setDefault(this.defaultId);
      }
    }

    this.logger.log(`Loaded ${this.configs.size} connection(s), default: ${this.defaultId}`);
  }

  private async createEnvDefaultConnection(): Promise<void> {
    const dbConfig = this.configService.get('database');
    if (!dbConfig) {
      throw new Error('Database configuration not found');
    }

    const now = Date.now();
    const config: DatabaseConnectionConfig = {
      id: ENV_DEFAULT_ID,
      name: 'Default',
      host: dbConfig.host,
      port: dbConfig.port,
      username: dbConfig.username,
      password: dbConfig.password,
      dbIndex: 0,
      tls: false,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    };

    // Create and test connection BEFORE persisting state
    const adapter = this.createAdapter(config);
    try {
      await adapter.connect();
    } catch (error) {
      // Connection failed - don't persist anything, let the error bubble up
      this.logger.error(`Failed to connect to default: ${error instanceof Error ? error.message : error}`);
      throw error;
    }

    // Connection succeeded - now persist state atomically
    await this.storage.saveConnection(config);
    this.configs.set(config.id, config);
    this.connections.set(config.id, adapter);
    this.defaultId = config.id;
    this.logger.log('Created and connected to default connection from env vars');
  }

  private createAdapter(config: DatabaseConnectionConfig): DatabasePort {
    return new UnifiedDatabaseAdapter({
      host: config.host,
      port: config.port,
      username: config.username || 'default',
      password: config.password || '',
    });
  }

  get(id?: string): DatabasePort {
    const targetId = id || this.defaultId;
    if (!targetId) {
      throw new Error('No connection available');
    }

    const connection = this.connections.get(targetId);
    if (!connection) {
      throw new Error(`Connection ${targetId} not found`);
    }

    return connection;
  }

  getDefault(): DatabasePort {
    return this.get();
  }

  getDefaultId(): string | null {
    return this.defaultId;
  }

  getConfig(id?: string): DatabaseConnectionConfig | null {
    const targetId = id || this.defaultId;
    if (!targetId) return null;
    return this.configs.get(targetId) || null;
  }

  async addConnection(request: CreateConnectionRequest): Promise<string> {
    const id = randomUUID();
    const now = Date.now();

    const config: DatabaseConnectionConfig = {
      id,
      name: request.name,
      host: request.host,
      port: request.port,
      username: request.username,
      password: request.password,
      dbIndex: request.dbIndex,
      tls: request.tls,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    };

    // Test connection first
    const testResult = await this.testConnection(request);
    if (!testResult.success) {
      throw new Error(testResult.error || 'Connection test failed');
    }

    await this.storage.saveConnection(config);
    this.configs.set(id, config);

    const adapter = this.createAdapter(config);
    await adapter.connect();
    this.connections.set(id, adapter);

    this.logger.log(`Added connection: ${config.name} (${config.host}:${config.port})`);
    return id;
  }

  async removeConnection(id: string): Promise<void> {
    if (id === ENV_DEFAULT_ID) {
      throw new Error('Cannot remove the default environment connection');
    }

    const connection = this.connections.get(id);
    if (connection && connection.isConnected()) {
      await connection.disconnect();
    }

    this.connections.delete(id);
    this.configs.delete(id);
    await this.storage.deleteConnection(id);

    if (this.defaultId === id) {
      const remaining = Array.from(this.configs.keys());
      if (remaining.length > 0) {
        await this.setDefault(remaining[0]);
      } else {
        this.defaultId = null;
      }
    }

    this.logger.log(`Removed connection: ${id}`);
  }

  async setDefault(id: string): Promise<void> {
    if (!this.configs.has(id)) {
      throw new Error(`Connection ${id} not found`);
    }

    // Unmark old default
    if (this.defaultId && this.defaultId !== id) {
      const oldConfig = this.configs.get(this.defaultId);
      if (oldConfig) {
        oldConfig.isDefault = false;
        await this.storage.updateConnection(this.defaultId, { isDefault: false });
      }
    }

    // Mark new default
    const newConfig = this.configs.get(id)!;
    newConfig.isDefault = true;
    await this.storage.updateConnection(id, { isDefault: true });
    this.defaultId = id;

    this.logger.log(`Set default connection: ${id}`);
  }

  async testConnection(request: CreateConnectionRequest): Promise<TestConnectionResponse> {
    const adapter = new UnifiedDatabaseAdapter({
      host: request.host,
      port: request.port,
      username: request.username || 'default',
      password: request.password || '',
    });

    try {
      await adapter.connect();
      const capabilities = adapter.getCapabilities();
      await adapter.disconnect();

      return {
        success: true,
        capabilities: {
          dbType: capabilities.dbType,
          version: capabilities.version,
          supportsCommandLog: capabilities.hasCommandLog,
          supportsSlotStats: capabilities.hasSlotStats,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  list(): ConnectionStatus[] {
    const result: ConnectionStatus[] = [];

    for (const [id, config] of this.configs.entries()) {
      const connection = this.connections.get(id);
      const isConnected = connection?.isConnected() ?? false;

      let capabilities: ConnectionStatus['capabilities'];
      if (isConnected && connection) {
        try {
          const caps = connection.getCapabilities();
          capabilities = {
            dbType: caps.dbType,
            version: caps.version,
            supportsCommandLog: caps.hasCommandLog,
            supportsSlotStats: caps.hasSlotStats,
          };
        } catch {
          // Capabilities unavailable
        }
      }

      result.push({
        id: config.id,
        name: config.name,
        host: config.host,
        port: config.port,
        username: config.username,
        dbIndex: config.dbIndex,
        tls: config.tls,
        isDefault: config.isDefault,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
        isConnected,
        capabilities,
      });
    }

    return result;
  }

  async reconnect(id: string): Promise<void> {
    const config = this.configs.get(id);
    if (!config) {
      throw new Error(`Connection ${id} not found`);
    }

    const oldAdapter = this.connections.get(id);
    if (oldAdapter && oldAdapter.isConnected()) {
      await oldAdapter.disconnect();
    }

    const adapter = this.createAdapter(config);
    await adapter.connect();
    this.connections.set(id, adapter);

    this.logger.log(`Reconnected: ${config.name} (${config.host}:${config.port})`);
  }

  isEnvDefault(id: string): boolean {
    return id === ENV_DEFAULT_ID;
  }

  findIdByHostPort(host: string, port: number): string | null {
    for (const [id, config] of this.configs.entries()) {
      if (config.host === host && config.port === port) {
        return id;
      }
    }
    return null;
  }
}
