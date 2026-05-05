import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CacheProposalService } from './cache-proposal.service';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class CacheExpirationCron implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheExpirationCron.name);
  private timer: NodeJS.Timeout | null = null;
  private intervalMs = DEFAULT_INTERVAL_MS;
  private now: () => number = Date.now;

  constructor(private readonly service: CacheProposalService) {}

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
      this.logger.log(`Expired ${expired} cache proposal(s)`);
    }
    return expired;
  }
}
