import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsUrl, IsBoolean, IsArray, IsObject, IsOptional, IsInt, Min, Max, IsNumber, IsEnum, ArrayMinSize, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type {
  Webhook,
  WebhookDelivery,
  WebhookEventType,
  DeliveryStatus,
  RetryPolicy,
  WebhookPayload,
  WebhookDeliveryConfig,
  WebhookAlertConfig,
  WebhookThresholds
} from '@betterdb/shared';
import { WebhookEventType as EventTypeEnum } from '@betterdb/shared';

/**
 * DTO for webhook delivery configuration
 */
export class WebhookDeliveryConfigDto implements WebhookDeliveryConfig {
  @ApiPropertyOptional({
    description: 'Request timeout in milliseconds (1000-120000)',
    example: 30000,
    minimum: 1000,
    maximum: 120000,
  })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(120000)
  timeoutMs?: number;

  @ApiPropertyOptional({
    description: 'Maximum response body size to store in bytes (1000-100000)',
    example: 10000,
    minimum: 1000,
    maximum: 100000,
  })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(100000)
  maxResponseBodyBytes?: number;
}

/**
 * DTO for webhook alert configuration
 */
export class WebhookAlertConfigDto implements WebhookAlertConfig {
  @ApiPropertyOptional({
    description: 'Hysteresis factor for alert recovery (0.5-0.99). Lower values require bigger recovery.',
    example: 0.9,
    minimum: 0.5,
    maximum: 0.99,
  })
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(0.99)
  hysteresisFactor?: number;
}

/**
 * DTO for webhook threshold configuration
 */
export class WebhookThresholdsDto implements WebhookThresholds {
  @ApiPropertyOptional({
    description: 'Memory critical threshold percentage (1-100)',
    example: 90,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  memoryCriticalPercent?: number;

  @ApiPropertyOptional({
    description: 'Connection critical threshold percentage (1-100)',
    example: 90,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  connectionCriticalPercent?: number;

  @ApiPropertyOptional({
    description: 'Compliance memory threshold percentage (1-100)',
    example: 80,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  complianceMemoryPercent?: number;

  @ApiPropertyOptional({
    description: 'Slowlog count threshold (1-10000)',
    example: 100,
    minimum: 1,
    maximum: 10000,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  slowlogCount?: number;

  @ApiPropertyOptional({
    description: 'Replication lag threshold in seconds (1-3600)',
    example: 10,
    minimum: 1,
    maximum: 3600,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3600)
  replicationLagSeconds?: number;

  @ApiPropertyOptional({
    description: 'Latency spike threshold in milliseconds (0 = baseline)',
    example: 0,
    minimum: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  latencySpikeMs?: number;

  @ApiPropertyOptional({
    description: 'Connection spike threshold count (0 = baseline)',
    example: 0,
    minimum: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  connectionSpikeCount?: number;
}

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

  @ApiPropertyOptional({
    description: 'Delivery configuration (timeout, response size limits)',
    type: WebhookDeliveryConfigDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookDeliveryConfigDto)
  deliveryConfig?: WebhookDeliveryConfigDto;

  @ApiPropertyOptional({
    description: 'Alert configuration (hysteresis settings)',
    type: WebhookAlertConfigDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookAlertConfigDto)
  alertConfig?: WebhookAlertConfigDto;

  @ApiPropertyOptional({
    description: 'Custom thresholds for this webhook',
    type: WebhookThresholdsDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookThresholdsDto)
  thresholds?: WebhookThresholdsDto;
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

  @ApiPropertyOptional({
    description: 'Delivery configuration (timeout, response size limits)',
    type: WebhookDeliveryConfigDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookDeliveryConfigDto)
  deliveryConfig?: WebhookDeliveryConfigDto;

  @ApiPropertyOptional({
    description: 'Alert configuration (hysteresis settings)',
    type: WebhookAlertConfigDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookAlertConfigDto)
  alertConfig?: WebhookAlertConfigDto;

  @ApiPropertyOptional({
    description: 'Custom thresholds for this webhook',
    type: WebhookThresholdsDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookThresholdsDto)
  thresholds?: WebhookThresholdsDto;
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

  @ApiPropertyOptional({
    description: 'Delivery configuration',
    type: WebhookDeliveryConfigDto,
  })
  deliveryConfig?: WebhookDeliveryConfig;

  @ApiPropertyOptional({
    description: 'Alert configuration',
    type: WebhookAlertConfigDto,
  })
  alertConfig?: WebhookAlertConfig;

  @ApiPropertyOptional({
    description: 'Custom thresholds',
    type: WebhookThresholdsDto,
  })
  thresholds?: WebhookThresholds;

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
