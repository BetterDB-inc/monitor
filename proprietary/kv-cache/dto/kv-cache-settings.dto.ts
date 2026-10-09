import { IsBoolean, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { MAX_KV_CACHE_HIT_RATE_THRESHOLD } from '@betterdb/shared';

export class UpdateKvCacheSettingsDto {
  @IsOptional() @IsBoolean() hitRateAlertEnabled?: boolean;
  @IsOptional() @IsNumber() @Min(0.01) @Max(MAX_KV_CACHE_HIT_RATE_THRESHOLD) hitRateThreshold?: number;
  @IsOptional() @IsBoolean() evictionAlertEnabled?: boolean;
}
