import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { ConnectionStatus, CreateConnectionRequest, TestConnectionResponse, DatabaseConnectionConfig } from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { DatabasePort } from '../common/interfaces/database-port.interface';
import { UnifiedDatabaseAdapter } from '../database/adapters/unified.adapter';
import { EnvelopeEncryptionService, getEncryptionService } from '../common/utils/encryption';

const ENV_DEFAULT_ID = 'env-default';

@Injectable()
export class ConnectionRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConnectionRegistry.name);
  private connections = new Map<string, DatabasePort>();
  private configs = new Map<string, DatabaseConnectionConfig>();
  private defaultId: string | null = null;
  private readonly encryption: EnvelopeEncryptionService | null;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly configService: ConfigService,
  ) {
    this.encryption = getEncryptionService();
    if (this.encryption) {
      this.logger.log('Password encryption enabled');
    } else {
      this.logger.warn(
        'ENCRYPTION_KEY not set - connection passwords will be stored in plaintext. ' +
        'Set ENCRYPTION_KEY environment variable (min 16 chars) to enable password encryption.'
      );
    }
  }

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
      // Check if DB_HOST was explicitly set in environment
      const isHostExplicitlySet = !!process.env.DB_HOST;

      if (!isHostExplicitlySet) {
        this.logger.log(
          'Waiting for database connection to be configured via the UI'
        );
        return;
      }

      // DB_HOST explicitly set - attempt connection but provide helpful guidance on failure
      const dbConfig = this.configService.get('database');
      try {
        this.logger.log(`Attempting to connect to configured database: ${dbConfig?.host}:${dbConfig?.port}`);
        await this.createEnvDefaultConnection();
        this.logger.log('Successfully connected to database from environment configuration');
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : error;
        this.logger.error(
          `Failed to connect to configured database (${dbConfig?.host}:${dbConfig?.port}): ${errorMsg}`
        );
        this.logger.warn(
          'App started without connections. Please verify your DB_HOST, DB_PORT, and other database ' +
          'environment variables are correct, or add a connection via the UI in Settings.'
        );
      }
    } else {
      for (const config of savedConnections) {
        // Decrypt password if encrypted
        const decryptedConfig = this.decryptConfig(config);

        // If decryption already failed, skip connection attempt
        if (decryptedConfig.credentialStatus === 'decryption_failed') {
          this.configs.set(config.id, decryptedConfig);
          // Create adapter anyway for reconnection attempts after key is fixed
          const adapter = this.createAdapter(decryptedConfig);
          this.connections.set(config.id, adapter);
          this.logger.warn(
            `Skipping connection to ${config.name}: password decryption failed. ` +
            'Fix ENCRYPTION_KEY and restart, or use POST /connections/{id}/reconnect after fixing.'
          );
          if (config.isDefault) {
            this.defaultId = config.id;
          }
          continue;
        }

        try {
          const adapter = this.createAdapter(decryptedConfig);
          await adapter.connect();
          this.connections.set(config.id, adapter);
          // Mark credentials as valid after successful connection
          this.configs.set(config.id, { ...decryptedConfig, credentialStatus: 'valid' });
          this.logger.log(`Connected to ${config.name} (${config.host}:${config.port})`);

          if (config.isDefault) {
            this.defaultId = config.id;
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          this.logger.warn(`Failed to connect to ${config.name}: ${errorMsg}`);

          // Check if this is an authentication error
          const isAuthError = this.isAuthenticationError(errorMsg);
          const credentialStatus = isAuthError ? 'invalid' : 'unknown';

          this.configs.set(config.id, {
            ...decryptedConfig,
            credentialStatus,
            credentialError: isAuthError ? errorMsg : undefined,
          });

          // Still store the adapter even if connection failed - allows reconnection
          const adapter = this.createAdapter(decryptedConfig);
          this.connections.set(config.id, adapter);

          if (config.isDefault) {
            this.defaultId = config.id;
          }
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

  /**
   * Check if an error message indicates an authentication failure
   */
  private isAuthenticationError(errorMsg: string): boolean {
    const authErrorPatterns = [
      /WRONGPASS/i,
      /NOAUTH/i,
      /invalid password/i,
      /authentication failed/i,
      /ERR AUTH/i,
      /invalid username-password/i,
      /NOPERM/i,
    ];
    return authErrorPatterns.some(pattern => pattern.test(errorMsg));
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

    // Connection succeeded - now persist state
    // If storage fails, disconnect the adapter to prevent leaks
    try {
      // Store encrypted config in DB, decrypted config in memory
      await this.storage.saveConnection(this.encryptConfig(config));
      // Mark credentials as valid since connection succeeded
      this.configs.set(config.id, { ...config, credentialStatus: 'valid' });
      this.connections.set(config.id, adapter);
      this.defaultId = config.id;
      this.logger.log('Created and connected to default connection from env vars');
    } catch (error) {
      // Storage failed - disconnect the adapter to prevent leaks
      await adapter.disconnect().catch(() => { });
      this.logger.error(`Failed to persist default connection: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  private createAdapter(config: DatabaseConnectionConfig): DatabasePort {
    return new UnifiedDatabaseAdapter({
      host: config.host,
      port: config.port,
      username: config.username || 'default',
      password: config.password || '',
    });
  }

  /**
   * Encrypt password in config for storage.
   * Returns a new config object with encrypted password.
   */
  private encryptConfig(config: DatabaseConnectionConfig): DatabaseConnectionConfig {
    if (!this.encryption || !config.password) {
      return config;
    }

    return {
      ...config,
      password: this.encryption.encrypt(config.password),
      passwordEncrypted: true,
    };
  }

  /**
   * Decrypt password in config for use.
   * Returns a new config object with decrypted password.
   * Sets credentialStatus to 'decryption_failed' if decryption fails.
   */
  private decryptConfig(config: DatabaseConnectionConfig): DatabaseConnectionConfig {
    if (!config.passwordEncrypted || !config.password) {
      return { ...config, credentialStatus: 'unknown' };
    }

    if (!this.encryption) {
      const errorMsg = 'ENCRYPTION_KEY not set but password is encrypted';
      this.logger.error(
        `Cannot decrypt password for ${config.name}: ${errorMsg}. ` +
        'The password was encrypted but the key is not available.'
      );
      return {
        ...config,
        password: undefined,
        credentialStatus: 'decryption_failed',
        credentialError: errorMsg,
      };
    }

    try {
      return {
        ...config,
        password: this.encryption.decrypt(config.password),
        passwordEncrypted: false, // Mark as decrypted in memory
        credentialStatus: 'unknown', // Will be validated on connection attempt
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Decryption failed';
      this.logger.error(
        `Failed to decrypt password for ${config.name}: ${errorMsg}`
      );
      return {
        ...config,
        password: undefined,
        credentialStatus: 'decryption_failed',
        credentialError: errorMsg,
      };
    }
  }

  get(id?: string): DatabasePort {
    const targetId = id || this.defaultId;
    if (!targetId) {
      throw new NotFoundException('No connection available');
    }

    const connection = this.connections.get(targetId);
    if (!connection) {
      throw new NotFoundException(
        `Connection '${targetId}' not found. Use GET /connections to list available connections.`
      );
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
      isDefault: false, // Will be set via setDefault() if requested
      createdAt: now,
      updatedAt: now,
    };

    // Create and connect adapter BEFORE persisting to storage
    // This ensures we don't end up with config in storage but no working connection
    const adapter = this.createAdapter(config);
    try {
      await adapter.connect();
    } catch (error) {
      // Connection failed - don't persist anything
      this.logger.error(`Failed to connect to ${config.name}: ${error instanceof Error ? error.message : error}`);
      throw new Error(`Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Connection succeeded - now persist state
    // If storage fails, disconnect the adapter to prevent leaks
    try {
      // Store encrypted config in DB, decrypted config in memory
      await this.storage.saveConnection(this.encryptConfig(config));
      // Mark credentials as valid since connection succeeded
      this.configs.set(id, { ...config, credentialStatus: 'valid' });
      this.connections.set(id, adapter);

      // Handle setAsDefault parameter
      if (request.setAsDefault) {
        await this.setDefault(id);
      }

      this.logger.log(`Added connection: ${config.name} (${config.host}:${config.port})`);
      return id;
    } catch (error) {
      // Storage failed - disconnect the adapter to prevent leaks
      await adapter.disconnect().catch(() => { });
      this.logger.error(`Failed to persist connection ${config.name}: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
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
      throw new NotFoundException(
        `Connection '${id}' not found. Use GET /connections to list available connections.`
      );
    }

    // Unmark old default (create new object instead of mutating)
    if (this.defaultId && this.defaultId !== id) {
      const oldConfig = this.configs.get(this.defaultId);
      if (oldConfig) {
        this.configs.set(this.defaultId, { ...oldConfig, isDefault: false });
        await this.storage.updateConnection(this.defaultId, { isDefault: false });
      }
    }

    // Mark new default (create new object instead of mutating)
    const newConfig = this.configs.get(id)!;
    this.configs.set(id, { ...newConfig, isDefault: true });
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
        credentialStatus: config.credentialStatus,
        credentialError: config.credentialError,
      });
    }

    return result;
  }

  async reconnect(id: string): Promise<void> {
    let config = this.configs.get(id);
    if (!config) {
      throw new NotFoundException(
        `Connection '${id}' not found. Use GET /connections to list available connections.`
      );
    }

    // If previous decryption failed, re-fetch from storage and try again
    // This allows recovery after fixing ENCRYPTION_KEY
    if (config.credentialStatus === 'decryption_failed') {
      this.logger.log(`Re-attempting decryption for ${config.name} after previous failure...`);
      const storedConfigs = await this.storage.getConnections();
      const storedConfig = storedConfigs.find(c => c.id === id);

      if (storedConfig) {
        config = this.decryptConfig(storedConfig);
        if (config.credentialStatus === 'decryption_failed') {
          // Still failing - update in-memory config with latest error and bail
          this.configs.set(id, config);
          throw new Error(`Password decryption still failing: ${config.credentialError}`);
        }
        // Decryption succeeded this time - continue with connection attempt
        this.logger.log(`Decryption succeeded for ${config.name}`);
      }
    }

    // Create and connect new adapter BEFORE disconnecting old one
    // This prevents leaving connection in broken state if new connection fails
    const newAdapter = this.createAdapter(config);

    try {
      await newAdapter.connect();

      // Only disconnect old adapter after new one successfully connects
      const oldAdapter = this.connections.get(id);
      if (oldAdapter && oldAdapter.isConnected()) {
        await oldAdapter.disconnect().catch((err) => {
          this.logger.warn(`Failed to disconnect old adapter for ${id}: ${err instanceof Error ? err.message : err}`);
        });
      }

      this.connections.set(id, newAdapter);

      // Update credential status to valid after successful reconnection
      this.configs.set(id, {
        ...config,
        credentialStatus: 'valid',
        credentialError: undefined,
      });

      this.logger.log(`Reconnected: ${config.name} (${config.host}:${config.port})`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      const isAuthError = this.isAuthenticationError(errorMsg);

      // Update credential status on failure
      this.configs.set(id, {
        ...config,
        credentialStatus: isAuthError ? 'invalid' : config.credentialStatus,
        credentialError: isAuthError ? errorMsg : config.credentialError,
      });

      throw error;
    }
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
