import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateScalingReadinessSettingsDto {
  @IsOptional()
  @IsBoolean()
  alertEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  alertThreshold?: number;
}
