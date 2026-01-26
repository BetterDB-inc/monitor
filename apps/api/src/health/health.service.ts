import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthResponse, WebhookEventType } from '@betterdb/shared';
import { DatabasePort } from '../common/interfaces/database-port.interface';
import { DatabaseConfig } from '../config/configuration';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private dbConfig: DatabaseConfig;
  private instanceUp = true; // Track instance health state

  constructor(
    @Inject('DATABASE_CLIENT')
    private readonly dbClient: DatabasePort,
    private readonly configService: ConfigService,
    @Optional() private readonly webhookDispatcher?: WebhookDispatcherService,
  ) {
    const config = this.configService.get<DatabaseConfig>('database');
    if (!config) {
      throw new Error('Database configuration not found');
    }
    this.dbConfig = config;
  }

  async getHealth(): Promise<HealthResponse> {
    if (!this.dbClient) {
      await this.handleInstanceDown('Database client not initialized');
      return {
        status: 'disconnected',
        database: {
          type: 'unknown',
          version: null,
          host: this.dbConfig.host,
          port: this.dbConfig.port,
        },
        capabilities: null,
        error: 'Database client not initialized',
      };
    }

    try {
      const isConnected = this.dbClient.isConnected();

      if (!isConnected) {
        await this.handleInstanceDown('Not connected to database');
        return {
          status: 'disconnected',
          database: {
            type: 'unknown',
            version: null,
            host: this.dbConfig.host,
            port: this.dbConfig.port,
          },
          capabilities: null,
          error: 'Not connected to database',
        };
      }

      const canPing = await this.dbClient.ping();

      if (!canPing) {
        await this.handleInstanceDown('Database ping failed');
        return {
          status: 'error',
          database: {
            type: 'unknown',
            version: null,
            host: this.dbConfig.host,
            port: this.dbConfig.port,
          },
          capabilities: null,
          error: 'Database ping failed',
        };
      }

      // Instance is up - check if it recovered
      await this.handleInstanceUp();

      const capabilities = this.dbClient.getCapabilities();

      return {
        status: 'connected',
        database: {
          type: capabilities.dbType,
          version: capabilities.version,
          host: this.dbConfig.host,
          port: this.dbConfig.port,
        },
        capabilities,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.handleInstanceDown(errorMessage);
      return {
        status: 'error',
        database: {
          type: 'unknown',
          version: null,
          host: this.dbConfig.host,
          port: this.dbConfig.port,
        },
        capabilities: null,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle instance going down - dispatch webhook if state changed
   */
  private async handleInstanceDown(reason: string): Promise<void> {
    if (this.instanceUp && this.webhookDispatcher) {
      this.logger.warn(`Instance went down: ${reason}`);
      this.instanceUp = false;
      try {
        await this.webhookDispatcher.dispatchHealthChange(WebhookEventType.INSTANCE_DOWN, {
          detectedAt: new Date().toISOString(),
          reason,
          host: this.dbConfig.host,
          port: this.dbConfig.port,
          message: `Database instance unreachable: ${reason}`,
        });
      } catch (err) {
        this.logger.error('Failed to dispatch instance.down webhook', err);
      }
    }
  }

  /**
   * Handle instance coming back up - dispatch webhook if state changed
   */
  private async handleInstanceUp(): Promise<void> {
    if (!this.instanceUp && this.webhookDispatcher) {
      this.logger.log('Instance recovered');
      this.instanceUp = true;
      try {
        await this.webhookDispatcher.dispatchHealthChange(WebhookEventType.INSTANCE_UP, {
          recoveredAt: new Date().toISOString(),
          host: this.dbConfig.host,
          port: this.dbConfig.port,
          message: 'Database instance recovered',
        });
      } catch (err) {
        this.logger.error('Failed to dispatch instance.up webhook', err);
      }
    }
  }
}
