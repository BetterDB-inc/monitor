import { IsBoolean, IsNumber, IsOptional, Min, Max, ValidateIf } from 'class-validator';

export class UpdateMetricForecastSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @ValidateIf((_obj, value) => value !== null)
  @IsNumber()
  @Min(0)
  ceiling?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(60_000)
  @Max(86_400_000)
  rollingWindowMs?: number;

  @IsOptional()
  @IsNumber()
  @Min(60_000)
  @Max(86_400_000)
  alertThresholdMs?: number;
}
