import { IsBoolean, IsNumber, Max, Min, ValidateIf } from 'class-validator';
import { MAX_KV_CACHE_HIT_RATE_THRESHOLD } from '@betterdb/shared';

const provided = (_: object, value: unknown) => value !== undefined;

export class UpdateKvCacheSettingsDto {
  @ValidateIf(provided) @IsBoolean() hitRateAlertEnabled?: boolean;
  @ValidateIf(provided) @IsNumber() @Min(0.01) @Max(MAX_KV_CACHE_HIT_RATE_THRESHOLD) hitRateThreshold?: number;
  @ValidateIf(provided) @IsBoolean() evictionAlertEnabled?: boolean;
}
