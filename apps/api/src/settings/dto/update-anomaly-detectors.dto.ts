import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
  Validate,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'criticalGreaterThanWarning', async: false })
class CriticalGreaterThanWarningValidator implements ValidatorConstraintInterface {
  validate(criticalZScore: number, args: ValidationArguments): boolean {
    const obj = args.object as DetectorConfigDto;
    if (obj.warningZScore === undefined || criticalZScore === undefined) {
      return true;
    }
    return obj.warningZScore < criticalZScore;
  }

  defaultMessage(): string {
    return 'warningZScore must be less than criticalZScore when both are provided';
  }
}

@ValidatorConstraint({ name: 'criticalAbsoluteGreaterThanWarning', async: false })
class CriticalAbsoluteGreaterThanWarningValidator
  implements ValidatorConstraintInterface {
  validate(criticalAbsolute: number, args: ValidationArguments): boolean {
    const obj = args.object as DetectorConfigDto;
    if (obj.warningAbsolute === undefined || criticalAbsolute === undefined) {
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
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(10)
  warningZScore?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 15 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(15)
  @Validate(CriticalGreaterThanWarningValidator)
  criticalZScore?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  warningAbsolute?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Validate(CriticalAbsoluteGreaterThanWarningValidator)
  criticalAbsolute?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  consecutiveRequired?: number;

  @ApiPropertyOptional({ minimum: 1000, maximum: 3600000 })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(3600000)
  cooldownMs?: number;
}

export class UpdateAnomalyDetectorsDto {
  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  connections?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  ops_per_sec?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  memory_used?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  input_kbps?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  output_kbps?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  slowlog_last_id?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  acl_denied?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  evicted_keys?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  blocked_clients?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  keyspace_misses?: DetectorConfigDto;

  @ApiPropertyOptional({ type: DetectorConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DetectorConfigDto)
  fragmentation_ratio?: DetectorConfigDto;
}
