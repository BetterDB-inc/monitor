import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsObject,
  Max,
  Min,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Like @IsOptional, but only `undefined` (field omitted) skips validation.
 * An explicit `null` is validated and rejected with 400, because null cannot
 * mean "unchanged" (omit the field) or "disabled" (send 0 for absolutes).
 */
const IsOptionalNotNull = () => ValidateIf((_obj: unknown, value: unknown) => value !== undefined);

@ValidatorConstraint({ name: 'criticalGreaterThanWarning', async: false })
class CriticalGreaterThanWarningValidator implements ValidatorConstraintInterface {
  validate(criticalZScore: number, args: ValidationArguments): boolean {
    const obj = args.object as DetectorConfigDto;
    if (obj.warningZScore == null || criticalZScore == null) {
      return true;
    }
    return obj.warningZScore < criticalZScore;
  }

  defaultMessage(): string {
    return 'warningZScore must be less than criticalZScore when both are provided';
  }
}

@ValidatorConstraint({ name: 'criticalAbsoluteGreaterThanWarning', async: false })
class CriticalAbsoluteGreaterThanWarningValidator implements ValidatorConstraintInterface {
  validate(criticalAbsolute: number, args: ValidationArguments): boolean {
    const obj = args.object as DetectorConfigDto;
    // 0 means "disabled", so there is no ordering to enforce.
    if (
      obj.warningAbsolute == null ||
      criticalAbsolute == null ||
      obj.warningAbsolute === 0 ||
      criticalAbsolute === 0
    ) {
      return true;
    }
    return obj.warningAbsolute < criticalAbsolute;
  }

  defaultMessage(): string {
    return 'warningAbsolute must be less than criticalAbsolute when both are provided';
  }
}

export class DetectorConfigDto {
  @ApiPropertyOptional({ minimum: 0.5, maximum: 10 })
  @IsOptionalNotNull()
  @IsNumber()
  @Min(0.5)
  @Max(10)
  warningZScore?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 15 })
  @IsOptionalNotNull()
  @IsNumber()
  @Min(1)
  @Max(15)
  @Validate(CriticalGreaterThanWarningValidator)
  criticalZScore?: number;

  @ApiPropertyOptional({
    minimum: 0,
    description:
      'Absolute WARNING threshold; must be > 0 to be active. 0 is a reserved value, not a threshold: ' +
      'it DISABLES the absolute WARNING check. Omit the field to leave it unchanged. ' +
      'null is rejected (400). In GET, overrides show a disabled threshold as 0; resolved omits it.',
    example: 10,
  })
  @IsOptionalNotNull()
  @IsNumber()
  @Min(0)
  warningAbsolute?: number;

  @ApiPropertyOptional({
    minimum: 0,
    description:
      'Absolute CRITICAL threshold; must be > 0 to be active. 0 is a reserved value, not a threshold: ' +
      'it DISABLES the absolute CRITICAL check. Omit the field to leave it unchanged. ' +
      'null is rejected (400). In GET, overrides show a disabled threshold as 0; resolved omits it.',
    example: 10,
  })
  @IsOptionalNotNull()
  @IsNumber()
  @Min(0)
  @Validate(CriticalAbsoluteGreaterThanWarningValidator)
  criticalAbsolute?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 20 })
  @IsOptionalNotNull()
  @IsInt()
  @Min(1)
  @Max(20)
  consecutiveRequired?: number;

  @ApiPropertyOptional({ minimum: 1000, maximum: 3600000 })
  @IsOptionalNotNull()
  @IsInt()
  @Min(1000)
  @Max(3600000)
  cooldownMs?: number;
}

export class UpdateAnomalyDetectorsDto {
  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptionalNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  connections?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptionalNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  ops_per_sec?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptionalNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  memory_used?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptionalNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  input_kbps?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptionalNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  output_kbps?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptionalNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  slowlog_last_id?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptionalNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  acl_denied?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptionalNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  evicted_keys?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptionalNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  blocked_clients?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptionalNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  keyspace_misses?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptionalNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  fragmentation_ratio?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptionalNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  error_replies?: DetectorConfigDto;
}
