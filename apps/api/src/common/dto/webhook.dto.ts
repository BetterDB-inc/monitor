import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsUrl, IsBoolean, IsArray, IsObject, IsOptional, IsInt, Min, IsEnum, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';
import type {
  Webhook,
  WebhookDelivery,
  WebhookEventType,
  DeliveryStatus,
  RetryPolicy,
  WebhookPayload
} from '@betterdb/shared';
import { WebhookEventType as EventTypeEnum } from '@betterdb/shared';

/**
 * DTO for creating a new webhook
 */
export class CreateWebhookDto {
  @ApiProperty({ description: 'Webhook name', example: 'Production Alerts' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Webhook URL', example: 'https://api.example.com/webhooks' })
  @IsUrl({ require_tld: false })
  url: string;

  @ApiPropertyOptional({ description: 'Secret for HMAC signing', example: 'wh_secret_abc123' })
  @IsString()
  @IsOptional()
  secret?: string;

  @ApiPropertyOptional({ description: 'Whether webhook is enabled', example: true, default: true })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @ApiProperty({
    description: 'Events to subscribe to',
    example: ['instance.down', 'memory.critical'],
    type: [String],
    enum: EventTypeEnum,
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'At least one event must be specified' })
  @IsEnum(EventTypeEnum, { each: true, message: 'Each event must be a valid webhook event type' })
  events: WebhookEventType[];

  @ApiPropertyOptional({
    description: 'Custom headers',
    example: { 'X-Custom-Header': 'value' }
  })
  @IsObject()
  @IsOptional()
  headers?: Record<string, string>;

  @ApiPropertyOptional({
    description: 'Retry policy configuration',
    example: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 }
  })
  @IsObject()
  @IsOptional()
  retryPolicy?: RetryPolicy;
}

/**
 * DTO for updating an existing webhook
 */
export class UpdateWebhookDto {
  @ApiPropertyOptional({ description: 'Webhook name', example: 'Production Alerts' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ description: 'Webhook URL', example: 'https://api.example.com/webhooks' })
  @IsUrl({ require_tld: false })
  @IsOptional()
  url?: string;

  @ApiPropertyOptional({ description: 'Secret for HMAC signing', example: 'wh_secret_abc123' })
  @IsString()
  @IsOptional()
  secret?: string;

  @ApiPropertyOptional({ description: 'Whether webhook is enabled', example: true })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: 'Events to subscribe to',
    example: ['instance.down', 'memory.critical'],
    type: [String],
    enum: EventTypeEnum,
  })
  @IsArray()
  @IsEnum(EventTypeEnum, { each: true, message: 'Each event must be a valid webhook event type' })
  @IsOptional()
  events?: WebhookEventType[];

  @ApiPropertyOptional({
    description: 'Custom headers',
    example: { 'X-Custom-Header': 'value' }
  })
  @IsObject()
  @IsOptional()
  headers?: Record<string, string>;

  @ApiPropertyOptional({
    description: 'Retry policy configuration',
    example: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 }
  })
  @IsObject()
  @IsOptional()
  retryPolicy?: RetryPolicy;
}

/**
 * DTO for webhook response
 */
export class WebhookDto implements Webhook {
  @ApiProperty({ description: 'Webhook ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string;

  @ApiProperty({ description: 'Webhook name', example: 'Production Alerts' })
  name: string;

  @ApiProperty({ description: 'Webhook URL', example: 'https://api.example.com/webhooks' })
  url: string;

  @ApiPropertyOptional({ description: 'Secret for HMAC signing (redacted)', example: 'wh_secret_***' })
  secret?: string;

  @ApiProperty({ description: 'Whether webhook is enabled', example: true })
  enabled: boolean;

  @ApiProperty({
    description: 'Events to subscribe to',
    example: ['instance.down', 'memory.critical'],
    type: [String]
  })
  events: WebhookEventType[];

  @ApiProperty({
    description: 'Custom headers',
    example: { 'X-Custom-Header': 'value' }
  })
  headers: Record<string, string>;

  @ApiProperty({
    description: 'Retry policy configuration',
    example: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 }
  })
  retryPolicy: RetryPolicy;

  @ApiProperty({ description: 'Creation timestamp (ms)', example: 1704934800000 })
  createdAt: number;

  @ApiProperty({ description: 'Last update timestamp (ms)', example: 1704938400000 })
  updatedAt: number;
}

/**
 * DTO for webhook delivery response
 */
export class WebhookDeliveryDto implements WebhookDelivery {
  @ApiProperty({ description: 'Delivery ID', example: '123e4567-e89b-12d3-a456-426614174001' })
  id: string;

  @ApiProperty({ description: 'Webhook ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  webhookId: string;

  @ApiProperty({ description: 'Event type', example: 'instance.down' })
  eventType: WebhookEventType;

  @ApiProperty({ description: 'Event payload', example: { instanceId: 'inst-123', timestamp: 1704934800000 } })
  payload: WebhookPayload;

  @ApiProperty({ description: 'Delivery status', enum: ['pending', 'success', 'failed', 'retrying'] })
  status: DeliveryStatus;

  @ApiPropertyOptional({ description: 'HTTP status code', example: 200 })
  statusCode?: number;

  @ApiPropertyOptional({ description: 'Response body', example: '{"status":"ok"}' })
  responseBody?: string;

  @ApiProperty({ description: 'Number of delivery attempts', example: 1 })
  attempts: number;

  @ApiPropertyOptional({ description: 'Next retry timestamp (ms)', example: 1704934801000 })
  nextRetryAt?: number;

  @ApiProperty({ description: 'Creation timestamp (ms)', example: 1704934800000 })
  createdAt: number;

  @ApiPropertyOptional({ description: 'Completion timestamp (ms)', example: 1704934800500 })
  completedAt?: number;

  @ApiPropertyOptional({ description: 'Request duration (ms)', example: 250 })
  durationMs?: number;
}

/**
 * Query DTO for listing deliveries
 */
export class GetDeliveriesQueryDto {
  @ApiPropertyOptional({ description: 'Webhook ID to filter by', example: '123e4567-e89b-12d3-a456-426614174000' })
  @IsString()
  @IsOptional()
  webhookId?: string;

  @ApiPropertyOptional({ description: 'Maximum number of deliveries to return', example: 50, default: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({ description: 'Number of deliveries to skip (for pagination)', example: 0, default: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  offset?: number;

  @ApiPropertyOptional({
    description: 'Delivery status to filter by',
    enum: ['pending', 'success', 'failed', 'retrying', 'dead_letter'],
    example: 'failed'
  })
  @IsEnum(['pending', 'success', 'failed', 'retrying', 'dead_letter'])
  @IsOptional()
  status?: DeliveryStatus;
}

/**
 * Response DTO for webhook test
 */
export class TestWebhookResponseDto {
  @ApiProperty({ description: 'Whether test was successful', example: true })
  success: boolean;

  @ApiPropertyOptional({ description: 'HTTP status code', example: 200 })
  statusCode?: number;

  @ApiPropertyOptional({ description: 'Response body', example: '{"status":"ok"}' })
  responseBody?: string;

  @ApiPropertyOptional({ description: 'Error message if test failed', example: 'Connection refused' })
  error?: string;

  @ApiProperty({ description: 'Request duration (ms)', example: 250 })
  durationMs: number;
}
