import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ACTIVITY_CONFIG, ActivityConfig, resolveActivityConfig } from './activity-config';
import { ActivityPruneJob } from './activity-prune.job';
import { ActivityService } from './activity.service';

@Module({
  imports: [StorageModule],
  providers: [
    {
      provide: ACTIVITY_CONFIG,
      useFactory: (): ActivityConfig => {
        return resolveActivityConfig(process.env);
      },
    },
    ActivityService,
    ActivityPruneJob,
  ],
  exports: [ActivityService],
})
export class ActivityModule {}
