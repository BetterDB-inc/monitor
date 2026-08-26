import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MemoryProposalService } from './memory-proposal.service';
import { STALE_APPLY_AFTER_MS } from './apply-timing';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class MemoryExpirationCron implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoryExpirationCron.name);
  private timer: NodeJS.Timeout | null = null;
  private intervalMs = DEFAULT_INTERVAL_MS;
  private now: () => number = Date.now;

  constructor(private readonly service: MemoryProposalService) {}

  configureForTesting(options: { intervalMs?: number; now?: () => number }): void {
    if (options.intervalMs !== undefined) {
      this.intervalMs = options.intervalMs;
    }
    if (options.now !== undefined) {
      this.now = options.now;
    }
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.logger.error(
          `Expiration tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<number> {
    const expired = await this.service.expireProposals(this.now(), 'system');
    if (expired > 0) {
      this.logger.log(`Expired ${expired} memory proposal(s)`);
    }
    // Rides the same timer rather than adding a second one. Distinct from
    // expiry: expires_at is how long a human has to decide, while this is how
    // long an in-flight apply may run before being presumed dead.
    const stale = await this.service.failStaleApplyingProposals(
      this.now() - STALE_APPLY_AFTER_MS,
      'system',
    );
    if (stale > 0) {
      this.logger.warn(
        `Failed ${stale} memory proposal(s) stuck in 'applying' — a process died mid-apply. ` +
          `Deletion may have been partial; verify the affected stores.`,
      );
    }
    return expired;
  }
}
