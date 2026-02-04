import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { DatabasePort } from '../interfaces/database-port.interface';

/**
 * Context passed to pollConnection() with all relevant connection information
 */
export interface ConnectionContext {
  /** Unique connection ID */
  connectionId: string;
  /** Human-readable connection name */
  connectionName: string;
  /** Database client for this connection */
  client: DatabasePort;
  /** Host of the database */
  host: string;
  /** Port of the database */
  port: number;
}

/**
 * Abstract base class for services that poll data from multiple database connections.
 *
 * Provides standardized multi-connection polling with:
 * - Automatic iteration over all connected databases
 * - Per-connection context (ID, name, client, host, port)
 * - Parallel polling of all connections
 * - Error isolation (one connection failure doesn't affect others)
 * - Cleanup hooks for per-connection state
 *
 * @example
 * ```typescript
 * @Injectable()
 * export class MyPollingService extends MultiConnectionPoller implements OnModuleInit {
 *   protected readonly logger = new Logger(MyPollingService.name);
 *   private lastSeenIds = new Map<string, number>();
 *
 *   constructor(connectionRegistry: ConnectionRegistry) {
 *     super(connectionRegistry);
 *   }
 *
 *   onModuleInit() {
 *     this.start();
 *   }
 *
 *   protected getIntervalMs(): number {
 *     return 5000;
 *   }
 *
 *   protected async pollConnection(ctx: ConnectionContext): Promise<void> {
 *     const data = await ctx.client.getData();
 *     // Process data for this specific connection
 *   }
 *
 *   protected onConnectionRemoved(connectionId: string): void {
 *     this.lastSeenIds.delete(connectionId);
 *   }
 * }
 * ```
 */
export abstract class MultiConnectionPoller implements OnModuleDestroy {
  protected abstract readonly logger: Logger;
  private intervalHandle: NodeJS.Timeout | null = null;
  private polling = false;
  private knownConnections = new Set<string>();

  constructor(protected readonly connectionRegistry: ConnectionRegistry) {}

  /**
   * Get the polling interval in milliseconds.
   * Can return different values on each call for dynamic intervals.
   */
  protected abstract getIntervalMs(): number;

  /**
   * Poll a single connection. Called for each connected database.
   * Errors thrown here are caught and logged, allowing other connections to continue.
   */
  protected abstract pollConnection(ctx: ConnectionContext): Promise<void>;

  /**
   * Called when a connection is removed from the registry.
   * Override to clean up per-connection state (Maps, caches, etc.)
   */
  protected onConnectionRemoved(connectionId: string): void {
    // Override in subclasses to clean up per-connection state
  }

  /**
   * Whether to poll disconnected connections.
   * Default is false (only poll connected connections).
   * Override to return true for services like HealthService that need to
   * detect when connections go down or recover.
   */
  protected shouldPollDisconnected(): boolean {
    return false;
  }

  /**
   * Start the multi-connection polling loop.
   * Call this in onModuleInit().
   */
  protected start(): void {
    if (this.intervalHandle) {
      this.logger.warn('Polling already started, ignoring duplicate start call');
      return;
    }

    this.logger.log(`Starting multi-connection polling every ${this.getIntervalMs()}ms`);

    // Run initial poll immediately
    this.tick().catch((err) => {
      this.logger.error(`Initial poll failed: ${err instanceof Error ? err.message : err}`);
    });

    // Schedule recurring polls
    const scheduleNext = () => {
      this.intervalHandle = setTimeout(async () => {
        await this.tick();
        if (this.intervalHandle) {
          scheduleNext();
        }
      }, this.getIntervalMs());
    };
    scheduleNext();
  }

  /**
   * Stop the multi-connection polling loop.
   * Called automatically on module destroy.
   */
  protected stop(): void {
    if (this.intervalHandle) {
      clearTimeout(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.log('Stopped multi-connection polling');
    }
  }

  /**
   * Called when the module is destroyed - cleans up the polling loop.
   */
  async onModuleDestroy(): Promise<void> {
    this.stop();
  }

  /**
   * Execute one polling tick across all connections.
   */
  private async tick(): Promise<void> {
    if (this.polling) {
      this.logger.debug('Previous poll still running, skipping this tick');
      return;
    }

    this.polling = true;

    try {
      const connections = this.connectionRegistry.list();
      const currentConnectionIds = new Set<string>();

      // Detect removed connections and clean up state
      for (const conn of connections) {
        currentConnectionIds.add(conn.id);
      }

      for (const knownId of this.knownConnections) {
        if (!currentConnectionIds.has(knownId)) {
          this.logger.log(`Connection ${knownId} removed, cleaning up state`);
          this.onConnectionRemoved(knownId);
        }
      }
      this.knownConnections = currentConnectionIds;

      // Poll instances in parallel (by default only connected ones, unless shouldPollDisconnected)
      const pollDisconnected = this.shouldPollDisconnected();
      const pollPromises = connections
        .filter((conn) => conn.isConnected || pollDisconnected)
        .map(async (conn) => {
          try {
            const client = this.connectionRegistry.get(conn.id);
            await this.pollConnection({
              connectionId: conn.id,
              connectionName: conn.name,
              client,
              host: conn.host,
              port: conn.port,
            });
          } catch (error) {
            this.logger.warn(
              `Poll failed for ${conn.name} (${conn.host}:${conn.port}): ${
                error instanceof Error ? error.message : error
              }`,
            );
          }
        });

      await Promise.allSettled(pollPromises);
    } catch (error) {
      this.logger.error(`Tick error: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Check if polling is currently active.
   */
  protected isPollingActive(): boolean {
    return this.intervalHandle !== null;
  }

  /**
   * Check if a poll is currently in progress.
   */
  protected isPollingBusy(): boolean {
    return this.polling;
  }
}
