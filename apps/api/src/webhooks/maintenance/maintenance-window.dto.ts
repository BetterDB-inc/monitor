import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { WebhookEventType } from '@betterdb/shared';
import type {
  CreateMaintenanceWindowRequest,
  MaintenanceWindowState,
  MaintenanceWindowView,
  UpdateMaintenanceWindowRequest,
} from '@betterdb/shared';

export class CreateMaintenanceWindowDto implements CreateMaintenanceWindowRequest {
  @ApiProperty({ description: 'Short label shown in the UI and on suppressed deliveries', example: 'Valkey 8.1 upgrade' })
  @IsString()
  @Length(1, 120)
  name: string;

  @ApiPropertyOptional({ description: 'Why alerts are paused (change ticket, runbook link)', example: 'CHG-1234 rolling restart' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(500)
  reason?: string | null;

  @ApiPropertyOptional({
    description: 'Connection to silence. Omit or null for every connection (and events that have no connection).',
    example: 'env-default',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(1, 200)
  connectionId?: string | null;

  @ApiPropertyOptional({
    description: 'Events to silence. Omit or [] to silence every event.',
    enum: WebhookEventType,
    isArray: true,
    example: ['instance.down', 'writes.rejected', 'failover.started'],
  })
  @IsOptional()
  @IsArray()
  @IsEnum(WebhookEventType, { each: true })
  events?: WebhookEventType[];

  @ApiPropertyOptional({ description: 'Start (epoch ms). Defaults to now.', example: 1767225600000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  startsAt?: number;

  @ApiProperty({ description: 'End (epoch ms). At most 7 days after the start.', example: 1767229200000 })
  @IsInt()
  @Min(0)
  endsAt: number;
}

export class UpdateMaintenanceWindowDto implements UpdateMaintenanceWindowRequest {
  @ApiPropertyOptional({ description: 'Short label' })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Length(1, 120)
  name?: string;

  @ApiPropertyOptional({ description: 'Why alerts are paused', nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(500)
  reason?: string | null;

  @ApiPropertyOptional({ description: 'Events to silence ([] = every event)', enum: WebhookEventType, isArray: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @IsEnum(WebhookEventType, { each: true })
  events?: WebhookEventType[];

  @ApiPropertyOptional({ description: 'New start (epoch ms); only before the window starts' })
  @IsOptional()
  @IsInt()
  @Min(0)
  startsAt?: number;

  @ApiPropertyOptional({ description: 'New end (epoch ms); extend or shorten an open window' })
  @IsOptional()
  @IsInt()
  @Min(0)
  endsAt?: number;
}

export class MaintenanceWindowDto implements MaintenanceWindowView {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) reason: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'null = every connection' }) connectionId: string | null;
  @ApiProperty({ enum: WebhookEventType, isArray: true, description: '[] = every event' }) events: WebhookEventType[];
  @ApiProperty() startsAt: number;
  @ApiProperty() endsAt: number;
  @ApiProperty({ nullable: true, type: Number }) endedAt: number | null;
  @ApiProperty({ nullable: true, type: String }) createdBy: string | null;
  @ApiProperty() createdAt: number;
  @ApiProperty() updatedAt: number;
  @ApiProperty({ enum: ['scheduled', 'active', 'ended'] }) state: MaintenanceWindowState;
}
