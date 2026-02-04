import { Injectable, Inject, Optional, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { HealthResponse, DetailedHealthResponse, WebhookEventType, ANOMALY_SERVICE, IAnomalyService, AllConnectionsHealthResponse } from '@betterdb/shared';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { LicenseService } from '@proprietary/license';
import { MultiConnectionPoller, ConnectionContext } from '../common/services/multi-connection-poller';

@Injectable()
export class HealthService extends MultiConnectionPoller implements OnModuleInit, OnModuleDestroy {
  protected readonly logger = new Logger(HealthService.name);
  // Per-connection health state tracking
  private instanceUpStates = new Map<string, boolean>();
  private readonly startTime = Date.now();
  private readonly HEALTH_POLL_INTERVAL_MS = 10000; // Check every 10 seconds
  private startupTimeout: NodeJS.Timeout | null = null;

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Optional() private readonly webhookDispatcher?: WebhookDispatcherService,
    @Optional() @Inject(ANOMALY_SERVICE) private readonly anomalyService?: IAnomalyService,
    @Optional() private readonly licenseService?: LicenseService,
  ) {
    super(connectionRegistry);
    // Initialize all existing connections as up
    for (const conn of connectionRegistry.list()) {
      this.instanceUpStates.set(conn.id, true);
    }
  }

  protected getIntervalMs(): number {
    return this.HEALTH_POLL_INTERVAL_MS;
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    // Perform health check for this connection - triggers webhooks on state change
    await this.getHealth(ctx.connectionId);
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.instanceUpStates.delete(connectionId);
    this.logger.debug(`Cleaned up health state for removed connection: ${connectionId}`);
  }

  onModuleInit() {
    // Delay initial poll to let connections fully initialize
    // This prevents false "down" states on startup
    this.startupTimeout = setTimeout(() => {
      this.startupTimeout = null;
      this.start();
      this.logger.log('Health polling started for all connections');
    }, 5000);
  }

  async onModuleDestroy(): Promise<void> {
    // Clear startup timeout if module is destroyed before polling starts
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
    await super.onModuleDestroy();
  }

  /**
   * Get health for a specific connection or the default connection
   */
  async getHealth(connectionId?: string): Promise<HealthResponse> {
    const targetId = connectionId || this.connectionRegistry.getDefaultId();
    if (!targetId) {
      return {
        status: 'disconnected',
        database: {
          type: 'unknown',
          version: null,
          host: 'unknown',
          port: 0,
        },
        capabilities: null,
        error: 'No connection available',
      };
    }

    const config = this.connectionRegistry.getConfig(targetId);
    if (!config) {
      return {
        status: 'disconnected',
        database: {
          type: 'unknown',
          version: null,
          host: 'unknown',
          port: 0,
        },
        capabilities: null,
        error: `Connection ${targetId} not found`,
      };
    }

    try {
      const client = this.connectionRegistry.get(targetId);
      const isConnected = client.isConnected();

      if (!isConnected) {
        await this.handleInstanceDown(targetId, config.host, config.port, 'Not connected to database');
        return {
          status: 'disconnected',
          database: {
            type: 'unknown',
            version: null,
            host: config.host,
            port: config.port,
          },
          capabilities: null,
          error: 'Not connected to database',
        };
      }

      const canPing = await client.ping();

      if (!canPing) {
        await this.handleInstanceDown(targetId, config.host, config.port, 'Database ping failed');
        return {
          status: 'error',
          database: {
            type: 'unknown',
            version: null,
            host: config.host,
            port: config.port,
          },
          capabilities: null,
          error: 'Database ping failed',
        };
      }

      // Instance is up - check if it recovered
      await this.handleInstanceUp(targetId, config.host, config.port);

      const capabilities = client.getCapabilities();

      return {
        status: 'connected',
        database: {
          type: capabilities.dbType,
          version: capabilities.version,
          host: config.host,
          port: config.port,
        },
        capabilities,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.handleInstanceDown(targetId, config.host, config.port, errorMessage);
      return {
        status: 'error',
        database: {
          type: 'unknown',
          version: null,
          host: config.host,
          port: config.port,
        },
        capabilities: null,
        error: errorMessage,
      };
    }
  }

  /**
   * Get health status for all connections
   */
  async getAllConnectionsHealth(): Promise<AllConnectionsHealthResponse> {
    const connections = this.connectionRegistry.list();
    const results: AllConnectionsHealthResponse['connections'] = [];

    for (const conn of connections) {
      const health = await this.getHealth(conn.id);
      results.push({
        connectionId: conn.id,
        connectionName: conn.name,
        ...health,
      });
    }

    const allConnected = results.every(r => r.status === 'connected');
    const anyConnected = results.some(r => r.status === 'connected');

    return {
      overallStatus: allConnected ? 'healthy' : (anyConnected ? 'degraded' : 'unhealthy'),
      connections: results,
      timestamp: Date.now(),
    };
  }

  /**
   * Handle instance going down - dispatch webhook if state changed
   */
  private async handleInstanceDown(connectionId: string, host: string, port: number, reason: string): Promise<void> {
    const wasUp = this.instanceUpStates.get(connectionId) !== false;
    if (wasUp && this.webhookDispatcher) {
      this.logger.warn(`Instance went down (${connectionId}): ${reason}`);
      this.instanceUpStates.set(connectionId, false);
      try {
        await this.webhookDispatcher.dispatchHealthChange(WebhookEventType.INSTANCE_DOWN, {
          detectedAt: new Date().toISOString(),
          reason,
          host,
          port,
          connectionId,
          message: `Database instance unreachable: ${reason}`,
        }, connectionId);
      } catch (err) {
        this.logger.error('Failed to dispatch instance.down webhook', err);
      }
    }
  }

  /**
   * Handle instance coming back up - dispatch webhook if state changed
   */
  private async handleInstanceUp(connectionId: string, host: string, port: number): Promise<void> {
    const wasDown = this.instanceUpStates.get(connectionId) === false;
    if (wasDown && this.webhookDispatcher) {
      this.logger.log(`Instance recovered (${connectionId})`);
      this.instanceUpStates.set(connectionId, true);
      try {
        await this.webhookDispatcher.dispatchHealthChange(WebhookEventType.INSTANCE_UP, {
          recoveredAt: new Date().toISOString(),
          host,
          port,
          connectionId,
          message: 'Database instance recovered',
        }, connectionId);
      } catch (err) {
        this.logger.error('Failed to dispatch instance.up webhook', err);
      }
    }
  }

  /**
   * Get detailed health information including warmup status
   */
  async getDetailedHealth(connectionId?: string): Promise<DetailedHealthResponse> {
    const basicHealth = await this.getHealth(connectionId);

    const detailed: DetailedHealthResponse = {
      ...basicHealth,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      timestamp: Date.now(),
    };

    // Add anomaly detection warmup status if available
    if (this.anomalyService) {
      detailed.anomalyDetection = this.anomalyService.getWarmupStatus();
    }

    // Add license validation status if available
    if (this.licenseService) {
      detailed.license = {
        isValidated: this.licenseService.isValidationComplete(),
        tier: this.licenseService.getLicenseTier(),
      };
    }

    return detailed;
  }
}
