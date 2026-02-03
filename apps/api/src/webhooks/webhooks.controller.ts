import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiHeader } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { WebhooksService } from './webhooks.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookProcessorService } from './webhook-processor.service';
import {
  CreateWebhookDto,
  UpdateWebhookDto,
  WebhookDto,
  WebhookDeliveryDto,
  GetDeliveriesQueryDto,
  TestWebhookResponseDto,
} from '../common/dto/webhook.dto';
import { ConnectionId, CONNECTION_ID_HEADER } from '../common/decorators';

// Rate limiting configuration
const THROTTLE_TTL = 60000; // 60 seconds
const CREATE_WEBHOOK_LIMIT = 25; // 25 requests per minute (allows ~20 test creates + 5 buffer)
const TEST_WEBHOOK_LIMIT = 10; // 10 requests per minute
const RETRY_DELIVERY_LIMIT = 20; // 20 requests per minute

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly dispatcherService: WebhookDispatcherService,
    private readonly processorService: WebhookProcessorService,
  ) {}

  @Post()
  @Throttle({ default: { limit: CREATE_WEBHOOK_LIMIT, ttl: THROTTLE_TTL } })
  @ApiOperation({ summary: 'Create a new webhook' })
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to associate with webhook' })
  @ApiResponse({ status: 201, description: 'Webhook created successfully', type: WebhookDto })
  @ApiResponse({ status: 400, description: 'Invalid webhook data' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async createWebhook(
    @ConnectionId() connectionId?: string,
    @Body() dto?: CreateWebhookDto,
  ): Promise<WebhookDto> {
    const webhook = await this.webhooksService.createWebhook({ ...dto!, connectionId });
    return this.webhooksService.redactSecret(webhook) as WebhookDto;
  }

  @Get()
  @ApiOperation({ summary: 'Get all webhooks' })
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  @ApiResponse({ status: 200, description: 'List of webhooks', type: [WebhookDto] })
  async getAllWebhooks(@ConnectionId() connectionId?: string): Promise<WebhookDto[]> {
    return this.webhooksService.getAllWebhooksRedacted(connectionId) as Promise<WebhookDto[]>;
  }

  @Get('allowed-events')
  @ApiOperation({ summary: 'Get allowed and locked webhook events for current license tier' })
  @ApiResponse({
    status: 200,
    description: 'Allowed and locked events',
    schema: {
      type: 'object',
      properties: {
        tier: { type: 'string', enum: ['community', 'pro', 'enterprise'], example: 'pro' },
        allowedEvents: { type: 'array', items: { type: 'string' }, example: ['instance.down', 'instance.up', 'anomaly.detected'] },
        lockedEvents: { type: 'array', items: { type: 'string' }, example: ['compliance.alert', 'audit.policy.violation'] },
      },
    },
  })
  async getAllowedEvents() {
    return this.webhooksService.getAllowedEvents();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a webhook by ID' })
  @ApiParam({ name: 'id', description: 'Webhook ID' })
  @ApiResponse({ status: 200, description: 'Webhook details', type: WebhookDto })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async getWebhook(@Param('id') id: string): Promise<WebhookDto> {
    return this.webhooksService.getWebhookRedacted(id) as Promise<WebhookDto>;
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a webhook' })
  @ApiParam({ name: 'id', description: 'Webhook ID' })
  @ApiResponse({ status: 200, description: 'Webhook updated successfully', type: WebhookDto })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  @ApiResponse({ status: 400, description: 'Invalid webhook data' })
  async updateWebhook(
    @Param('id') id: string,
    @Body() dto: UpdateWebhookDto,
  ): Promise<WebhookDto> {
    const webhook = await this.webhooksService.updateWebhook(id, dto);
    return this.webhooksService.redactSecret(webhook) as WebhookDto;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a webhook' })
  @ApiParam({ name: 'id', description: 'Webhook ID' })
  @ApiResponse({ status: 204, description: 'Webhook deleted successfully' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async deleteWebhook(@Param('id') id: string): Promise<void> {
    await this.webhooksService.deleteWebhook(id);
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: TEST_WEBHOOK_LIMIT, ttl: THROTTLE_TTL } })
  @ApiOperation({ summary: 'Test a webhook by sending a test event' })
  @ApiParam({ name: 'id', description: 'Webhook ID' })
  @ApiResponse({ status: 200, description: 'Test result', type: TestWebhookResponseDto })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async testWebhook(@Param('id') id: string): Promise<TestWebhookResponseDto> {
    const webhook = await this.webhooksService.getWebhook(id);
    return this.dispatcherService.testWebhook(webhook);
  }

  @Get(':id/deliveries')
  @ApiOperation({ summary: 'Get webhook deliveries' })
  @ApiParam({ name: 'id', description: 'Webhook ID' })
  @ApiResponse({ status: 200, description: 'List of deliveries', type: [WebhookDeliveryDto] })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async getWebhookDeliveries(
    @Param('id') id: string,
    @Query() query: GetDeliveriesQueryDto,
  ): Promise<WebhookDeliveryDto[]> {
    // Verify webhook exists
    await this.webhooksService.getWebhook(id);

    const limit = query.limit || 100;
    const offset = query.offset || 0;
    return this.webhooksService.getDeliveries(id, limit, offset) as Promise<WebhookDeliveryDto[]>;
  }

  @Get('deliveries/:deliveryId')
  @ApiOperation({ summary: 'Get a delivery by ID' })
  @ApiParam({ name: 'deliveryId', description: 'Delivery ID' })
  @ApiResponse({ status: 200, description: 'Delivery details', type: WebhookDeliveryDto })
  @ApiResponse({ status: 404, description: 'Delivery not found' })
  async getDelivery(@Param('deliveryId') deliveryId: string): Promise<WebhookDeliveryDto> {
    return this.webhooksService.getDelivery(deliveryId) as Promise<WebhookDeliveryDto>;
  }

  @Post('deliveries/:deliveryId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: RETRY_DELIVERY_LIMIT, ttl: THROTTLE_TTL } })
  @ApiOperation({ summary: 'Manually retry a failed delivery' })
  @ApiParam({ name: 'deliveryId', description: 'Delivery ID' })
  @ApiResponse({ status: 202, description: 'Retry queued' })
  @ApiResponse({ status: 404, description: 'Delivery not found' })
  @ApiResponse({ status: 400, description: 'Cannot retry: max attempts reached or invalid status' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async retryDelivery(@Param('deliveryId') deliveryId: string): Promise<{ message: string }> {
    await this.processorService.manualRetry(deliveryId);
    return { message: 'Retry queued' };
  }

  @Get('stats/retry-queue')
  @ApiOperation({ summary: 'Get retry queue statistics' })
  @ApiResponse({
    status: 200,
    description: 'Retry queue statistics',
    schema: {
      type: 'object',
      properties: {
        pendingRetries: { type: 'number', example: 5 },
        nextRetryTime: { type: 'number', example: 1704934800000, nullable: true },
      },
    },
  })
  async getRetryStats(): Promise<{ pendingRetries: number; nextRetryTime: number | null }> {
    return this.processorService.getRetryStats();
  }
}
