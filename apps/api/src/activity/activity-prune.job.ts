import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ActivityService } from './activity.service';

export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ActivityPruneJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ActivityPruneJob.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly activity: ActivityService) {}

  onApplicationBootstrap(): void {
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, PRUNE_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer === null) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  private async runOnce(): Promise<void> {
    try {
      const removed = await this.activity.prune();
      if (removed > 0) {
        this.logger.log(`Pruned ${removed} activity event(s)`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Activity prune failed: ${message}`);
    }
  }
}
