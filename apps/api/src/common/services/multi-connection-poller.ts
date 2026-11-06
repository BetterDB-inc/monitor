import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { DatabasePort } from '../interfaces/database-port.interface';
import type { LogSource } from '../interfaces/storage-port.interface';
import { withTimeout } from '../utils/with-timeout';

/** Tracking key for a log source: the run id when known, otherwise the address. */
export function logSourceKey(source: LogSource): string {
  return source.runId ? `run:${source.runId}` : `addr:${source.host}:${source.port}`;
}

export function describeLogSource(source: LogSource): string {
  return `${source.host}:${source.port}${source.runId ? ` (run ${source.runId.slice(0, 8)})` : ''}`;
}

// INFO refused for good (ACL, a renamed or disabled command): the address is
// the only identity there will be. Any other failure is a moment the run id
// could not be read, and storing that poll under the address would store the
// same entries again under the run id once INFO answers.
const INFO_UNAVAILABLE = /NOPERM|unknown (sub)?command|disabled/i;

export interface LogSourceRead {
  source: LogSource;
  key: string;
  /** Socket generation the source was read on; null when the adapter does not report one. */
  generation: number | null;
}

/**
 * Tracks the server process each connection's slow/command log reads are
 * served by. Log IDs are per process, so the run id (INFO server) identifies
 * the source; the address is where the process was reached and only stands in
 * for the identity when the run id is unavailable. The same process reached
 * through another address (a load balancer IP per zone, IPv4 vs IPv6) keeps its
 * identity, and a restarted process gets a new one even on the same address.
 *
 * Address tracking cannot tell nodes apart behind one address (an SSH tunnel or
 * a proxy to several nodes with INFO denied); entries are then attributed to the
 * address, and a node change behind it shows only through ID wraparound.
 */
export class LogSourceTracker {
  private readonly tracked = new Map<string, { key: string; label: string }>();
  // Connections that have reported a run id: once seen, an INFO failure means
  // the source is unknown for that poll, not that it moved to address tracking.
  private readonly withRunId = new Set<string>();

  /**
   * `hasRunIdHistory` tells whether the connection's stored entries carry a run
   * id, so a restart of this process, or another replica storing them, is not
   * mistaken for a source without one. Asked on each failed INFO until it is.
   */
  constructor(private readonly hasRunIdHistory: (connectionId: string) => Promise<boolean>) {}

  /** The current source, or null when this poll's entries cannot be attributed. */
  async read(ctx: ConnectionContext): Promise<LogSourceRead | null> {
    const generation = ctx.client.getConnectionGeneration?.() ?? null;
    let runId = '';
    try {
      const info = await ctx.client.getInfo(['server']);
      runId = (info.server as Record<string, string> | undefined)?.run_id ?? '';
    } catch (err) {
      if (!INFO_UNAVAILABLE.test(err instanceof Error ? err.message : String(err))) return null;
      // INFO denied or unsupported: fall back to tracking by address.
    }
    if (!runId && !this.withRunId.has(ctx.connectionId)) {
      try {
        if (await this.hasRunIdHistory(ctx.connectionId)) this.withRunId.add(ctx.connectionId);
      } catch {
        return null;
      }
    }
    if (!runId && this.withRunId.has(ctx.connectionId)) return null;
    // Read after the INFO reply: a reconnect while it was pending would resend
    // it to another node, so the endpoint must come from the same socket.
    if (generation !== null && ctx.client.getConnectionGeneration?.() !== generation) return null;
    if (runId) this.withRunId.add(ctx.connectionId);
    const endpoint = ctx.client.getServingEndpoint?.() ?? { host: ctx.host, port: ctx.port };
    const source = { ...endpoint, runId };
    return { source, key: logSourceKey(source), generation };
  }

  /** Records `read` as the connection's source; returns the previous label when it moved. */
  track(connectionId: string, read: LogSourceRead): { changed: boolean; previous?: string } {
    const previous = this.tracked.get(connectionId);
    if (previous?.key === read.key) return { changed: false };
    this.tracked.set(connectionId, { key: read.key, label: describeLogSource(read.source) });
    return { changed: true, previous: previous?.label };
  }

  /**
   * Whether the connection is still on the source of `before`: same identity,
   * and no reconnect in between (a move to another process and back would keep
   * the identity but mix that process's entries into the batch).
   */
  async unchanged(ctx: ConnectionContext, before: LogSourceRead): Promise<boolean> {
    const after = await this.read(ctx);
    return after !== null && after.key === before.key && after.generation === before.generation;
  }

  forget(connectionId: string): void {
    this.tracked.delete(connectionId);
    this.withRunId.delete(connectionId);
  }
}

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
  connectionType?: 'agent' | 'direct' | 'external';
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
  // Permanent latch set by stop() (only ever reached via onModuleDestroy): once
  // torn down, a deferred start() must stay suppressed — see start()/stop().
  private stopped = false;
  private knownConnections = new Set<string>();
  // Connections whose poll is still running; a later tick skips them.
  private inFlight = new Set<string>();

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
   * How long a tick waits for one connection's poll. A poll that runs longer
   * keeps running, and that connection is skipped until it settles, so a
   * stalled server cannot hold up the other connections' polls.
   */
  protected getPollTimeoutMs(): number {
    return Math.max(this.getIntervalMs() * 2, 10_000);
  }

  private lastPolledVersion = new Map<string, number>();

  protected supportsExternalConnections(): boolean {
    return false;
  }

  protected skipUnchangedSamples(): boolean {
    return true;
  }

  protected pollsSentinels(): boolean {
    return false;
  }

  protected isSentinelConnection(id: string): boolean {
    try {
      return this.connectionRegistry.get(id).getCapabilities().isSentinel === true;
    } catch {
      return false;
    }
  }

  /**
   * Start the multi-connection polling loop.
   * Call this in onModuleInit().
   */
  protected start(): void {
    if (this.stopped) {
      // onModuleDestroy already latched this poller shut. A start() deferred
      // past teardown (e.g. a startAfter() gate
      // resolving after app.close() within its validation window) must NOT
      // re-arm the timer chain — an unstoppable tick loop holds the event loop
      // open and blocks a clean shutdown.
      this.logger.debug('Poller already destroyed, ignoring start call');
      return;
    }
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

  protected startAfter(gate: Promise<unknown>): void {
    void gate
      .finally(() => this.start())
      .catch((error) => {
        this.logger.error(`Deferred start failed: ${error instanceof Error ? error.message : error}`);
      });
  }

  /**
   * Stop the multi-connection polling loop.
   * Called automatically on module destroy.
   */
  protected stop(): void {
    // Latch before clearing: stop() is reached only from onModuleDestroy, so
    // this permanently suppresses any start() that races teardown.
    this.stopped = true;
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
          this.lastPolledVersion.delete(knownId);
        }
      }
      this.knownConnections = currentConnectionIds;

      // Poll instances in parallel (by default only connected ones, unless shouldPollDisconnected)
      const pollDisconnected = this.shouldPollDisconnected();
      const pollExternal = this.supportsExternalConnections();
      const skipUnchanged = this.skipUnchangedSamples();
      const pollSentinels = this.pollsSentinels();
      const pollPromises = connections
        .filter((conn) => conn.isConnected || pollDisconnected)
        .filter((conn) => conn.connectionType !== 'external' || pollExternal)
        .filter((conn) => pollSentinels || !this.isSentinelConnection(conn.id))
        .filter((conn) => {
          if (!this.inFlight.has(conn.id)) return true;
          this.logger.debug(`Previous poll of ${conn.name} still running, skipping it this tick`);
          return false;
        })
        .map(async (conn) => {
          const describe = `${conn.name} (${conn.host}:${conn.port})`;
          this.inFlight.add(conn.id);
          const poll = (async () => {
            try {
              const client = this.connectionRegistry.get(conn.id);
              const version = client.sampleVersion?.() ?? null;
              if (skipUnchanged && version !== null && this.lastPolledVersion.get(conn.id) === version) {
                return;
              }
              await this.pollConnection({
                connectionId: conn.id,
                connectionName: conn.name,
                client,
                host: conn.host,
                port: conn.port,
                connectionType: conn.connectionType,
              });
              if (version !== null) {
                this.lastPolledVersion.set(conn.id, version);
              }
            } catch (error) {
              this.logger.warn(`Poll failed for ${describe}: ${error instanceof Error ? error.message : error}`);
            } finally {
              this.inFlight.delete(conn.id);
              // Removed while this poll ran: its writes landed after the cleanup.
              if (!this.knownConnections.has(conn.id)) {
                this.onConnectionRemoved(conn.id);
                this.lastPolledVersion.delete(conn.id);
              }
            }
          })();
          const timeoutMs = this.getPollTimeoutMs();
          await withTimeout(poll, timeoutMs).catch(() => {
            this.logger.warn(`Poll of ${describe} still running after ${timeoutMs}ms; skipping it until it settles`);
          });
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
