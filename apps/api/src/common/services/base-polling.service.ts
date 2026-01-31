import { OnModuleDestroy, Logger } from '@nestjs/common';

/**
 * Configuration for a polling loop
 */
export interface PollingLoop {
  /** Unique name for the polling loop (used in logs) */
  name: string;
  /** Returns the interval in milliseconds for this loop */
  getIntervalMs: () => number;
  /** The polling function to execute */
  poll: () => Promise<void>;
  /** Whether to run an initial poll immediately (default: true) */
  initialPoll?: boolean;
}

/**
 * Abstract base class for services that need to poll data periodically.
 * Provides standardized polling loop management with:
 * - Multiple named polling loops
 * - Concurrency protection (prevents overlapping polls)
 * - Proper cleanup on module destroy
 * - Dynamic interval support (reads interval on each iteration)
 *
 * @example
 * ```typescript
 * @Injectable()
 * export class MyService extends BasePollingService {
 *   protected readonly logger = new Logger(MyService.name);
 *
 *   async onModuleInit() {
 *     this.startPollingLoop({
 *       name: 'myData',
 *       getIntervalMs: () => 5000,
 *       poll: () => this.fetchData(),
 *     });
 *   }
 * }
 * ```
 */
export abstract class BasePollingService implements OnModuleDestroy {
  protected abstract readonly logger: Logger;

  private readonly activePolls = new Map<string, NodeJS.Timeout | null>();
  private readonly isPolling = new Map<string, boolean>();

  /**
   * Start a new polling loop
   * @param loop Configuration for the polling loop
   */
  protected startPollingLoop(loop: PollingLoop): void {
    const { name, getIntervalMs, poll, initialPoll = true } = loop;

    if (this.activePolls.has(name)) {
      this.logger.warn(`Polling loop '${name}' is already active, skipping`);
      return;
    }

    this.logger.log(`Starting polling loop '${name}' (interval: ${getIntervalMs()}ms)`);

    // Mark as active immediately (null = initial poll in progress, timeout assigned after)
    this.activePolls.set(name, null);

    const runPoll = async () => {
      // Concurrency protection - skip if already polling
      if (this.isPolling.get(name)) {
        this.logger.debug(`Polling loop '${name}' is still running, skipping this iteration`);
        return;
      }

      this.isPolling.set(name, true);
      try {
        await poll();
      } catch (error) {
        this.logger.error(
          `Error in polling loop '${name}': ${error instanceof Error ? error.message : 'Unknown error'}`,
          error instanceof Error ? error.stack : undefined,
        );
      } finally {
        this.isPolling.set(name, false);
      }
    };

    const scheduleNextPoll = () => {
      // Check if the loop was stopped while we were polling
      if (!this.activePolls.has(name)) {
        return;
      }

      const timeout = setTimeout(async () => {
        await runPoll();
        scheduleNextPoll();
      }, getIntervalMs());

      this.activePolls.set(name, timeout);
    };

    // Run initial poll if configured
    if (initialPoll) {
      runPoll().then(() => scheduleNextPoll());
    } else {
      scheduleNextPoll();
    }
  }

  /**
   * Stop a specific polling loop
   * @param name Name of the polling loop to stop
   */
  protected stopPollingLoop(name: string): void {
    if (this.activePolls.has(name)) {
      const timeout = this.activePolls.get(name);
      if (timeout) {
        clearTimeout(timeout);
      }
      this.activePolls.delete(name);
      this.isPolling.delete(name);
      this.logger.log(`Stopped polling loop '${name}'`);
    }
  }

  /**
   * Stop all active polling loops
   */
  protected stopAllPollingLoops(): void {
    for (const [name, timeout] of this.activePolls.entries()) {
      if (timeout) {
        clearTimeout(timeout);
      }
      this.logger.debug(`Cleared polling loop '${name}'`);
    }
    this.activePolls.clear();
    this.isPolling.clear();
    this.logger.log('All polling loops stopped');
  }

  /**
   * Get names of all active polling loops
   */
  protected getActivePollingLoops(): string[] {
    return Array.from(this.activePolls.keys());
  }

  /**
   * Check if a polling loop is currently running
   */
  protected isPollingLoopActive(name: string): boolean {
    return this.activePolls.has(name);
  }

  /**
   * Check if a polling loop is currently executing its poll function
   */
  protected isPollingLoopBusy(name: string): boolean {
    return this.isPolling.get(name) ?? false;
  }

  /**
   * Called when the module is destroyed - cleans up all polling loops
   */
  async onModuleDestroy(): Promise<void> {
    this.stopAllPollingLoops();
  }
}
