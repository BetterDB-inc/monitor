import { MAX_SCALING_READINESS_ALERT_THRESHOLD } from '@betterdb/shared';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateScalingReadinessSettingsDto {
  @IsOptional()
  @IsBoolean()
  alertEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SCALING_READINESS_ALERT_THRESHOLD)
  alertThreshold?: number;
}
