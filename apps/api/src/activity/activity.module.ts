import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { StorageModule } from '../storage/storage.module';
import { ACTIVITY_CONFIG, ActivityConfig, resolveActivityConfig } from './activity-config';
import { ActivityInterceptor } from './activity.interceptor';
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
    { provide: APP_INTERCEPTOR, useClass: ActivityInterceptor },
  ],
  exports: [ActivityService],
})
export class ActivityModule {}
