import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { WORKSPACE_CONFIG, type WorkspaceConfig } from '../auth/workspace-config';
import { ActivityService } from './activity.service';

export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ActivityPruneJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ActivityPruneJob.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly activity: ActivityService,
    @Optional() @Inject(WORKSPACE_CONFIG) private readonly config: WorkspaceConfig | null = null,
  ) {}

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
    if (this.config?.mode !== 'disabled') {
      await this.prune('Activity', 'activity event', () => this.activity.prune());
    }
    await this.prune('Placement action', 'placement action', () =>
      this.activity.prunePlacementActions(),
    );
  }

  private async prune(label: string, noun: string, run: () => Promise<number>): Promise<void> {
    try {
      const removed = await run();
      if (removed > 0) {
        this.logger.log(`Pruned ${removed} ${noun}(s)`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${label} prune failed: ${message}`);
    }
  }
}
