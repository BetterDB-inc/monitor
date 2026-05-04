import { Pool } from 'pg';
import {
  Webhook,
  WebhookDelivery,
  WebhookEventType,
} from '../../../common/interfaces/storage-port.interface';
import { RowMappers } from '../base-sql.adapter';

export class WebhookPostgresRepository {
  constructor(
    private readonly pool: Pool,
    private readonly mappers: RowMappers,
  ) {}

  async createWebhook(webhook: Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>): Promise<Webhook> {
    const result = await this.pool.query(
      `INSERT INTO webhooks (name, url, secret, enabled, events, headers, retry_policy, delivery_config, alert_config, thresholds, connection_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        webhook.name,
        webhook.url,
        webhook.secret,
        webhook.enabled,
        webhook.events,
        JSON.stringify(webhook.headers || {}),
        JSON.stringify(webhook.retryPolicy),
        webhook.deliveryConfig ? JSON.stringify(webhook.deliveryConfig) : null,
        webhook.alertConfig ? JSON.stringify(webhook.alertConfig) : null,
        webhook.thresholds ? JSON.stringify(webhook.thresholds) : null,
        webhook.connectionId || null,
      ],
    );

    return this.mappers.mapWebhookRow(result.rows[0]);
  }

  async getWebhook(id: string): Promise<Webhook | null> {
    const result = await this.pool.query('SELECT * FROM webhooks WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;

    return this.mappers.mapWebhookRow(result.rows[0]);
  }

  async getWebhooksByInstance(connectionId?: string): Promise<Webhook[]> {
    if (connectionId) {
      const result = await this.pool.query(
        'SELECT * FROM webhooks WHERE connection_id = $1 OR connection_id IS NULL ORDER BY created_at DESC',
        [connectionId],
      );
      return result.rows.map((row) => this.mappers.mapWebhookRow(row));
    }

    // No connectionId provided - only return global webhooks (not scoped to any connection)
    const result = await this.pool.query(
      'SELECT * FROM webhooks WHERE connection_id IS NULL ORDER BY created_at DESC',
    );
    return result.rows.map((row) => this.mappers.mapWebhookRow(row));
  }

  async getWebhooksByEvent(event: WebhookEventType, connectionId?: string): Promise<Webhook[]> {
    if (connectionId) {
      // Return webhooks scoped to this connection OR global webhooks (no connectionId)
      const result = await this.pool.query(
        'SELECT * FROM webhooks WHERE enabled = true AND $1 = ANY(events) AND (connection_id = $2 OR connection_id IS NULL)',
        [event, connectionId],
      );
      return result.rows.map((row) => this.mappers.mapWebhookRow(row));
    }

    // No connectionId provided - only return global webhooks (not scoped to any connection)
    const result = await this.pool.query(
      'SELECT * FROM webhooks WHERE enabled = true AND $1 = ANY(events) AND connection_id IS NULL',
      [event],
    );

    return result.rows.map((row) => this.mappers.mapWebhookRow(row));
  }

  async updateWebhook(
    id: string,
    updates: Partial<Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<Webhook | null> {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      params.push(updates.name);
    }
    if (updates.url !== undefined) {
      setClauses.push(`url = $${paramIndex++}`);
      params.push(updates.url);
    }
    if (updates.secret !== undefined) {
      setClauses.push(`secret = $${paramIndex++}`);
      params.push(updates.secret);
    }
    if (updates.enabled !== undefined) {
      setClauses.push(`enabled = $${paramIndex++}`);
      params.push(updates.enabled);
    }
    if (updates.events !== undefined) {
      setClauses.push(`events = $${paramIndex++}`);
      params.push(updates.events);
    }
    if (updates.headers !== undefined) {
      setClauses.push(`headers = $${paramIndex++}`);
      params.push(JSON.stringify(updates.headers));
    }
    if (updates.retryPolicy !== undefined) {
      setClauses.push(`retry_policy = $${paramIndex++}`);
      params.push(JSON.stringify(updates.retryPolicy));
    }
    if (updates.deliveryConfig !== undefined) {
      setClauses.push(`delivery_config = $${paramIndex++}`);
      params.push(JSON.stringify(updates.deliveryConfig));
    }
    if (updates.alertConfig !== undefined) {
      setClauses.push(`alert_config = $${paramIndex++}`);
      params.push(JSON.stringify(updates.alertConfig));
    }
    if (updates.thresholds !== undefined) {
      setClauses.push(`thresholds = $${paramIndex++}`);
      params.push(JSON.stringify(updates.thresholds));
    }
    if (updates.connectionId !== undefined) {
      setClauses.push(`connection_id = $${paramIndex++}`);
      params.push(updates.connectionId);
    }

    if (setClauses.length === 0) {
      return this.getWebhook(id);
    }

    setClauses.push(`updated_at = NOW()`);
    params.push(id);

    const result = await this.pool.query(
      `UPDATE webhooks SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      params,
    );

    if (result.rows.length === 0) return null;

    return this.mappers.mapWebhookRow(result.rows[0]);
  }

  async deleteWebhook(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM webhooks WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async createDelivery(
    delivery: Omit<WebhookDelivery, 'id' | 'createdAt'>,
  ): Promise<WebhookDelivery> {
    const result = await this.pool.query(
      `INSERT INTO webhook_deliveries (
        webhook_id, event_type, payload, status, status_code, response_body,
        attempts, next_retry_at, completed_at, duration_ms, connection_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        delivery.webhookId,
        delivery.eventType,
        JSON.stringify(delivery.payload),
        delivery.status,
        delivery.statusCode || null,
        delivery.responseBody || null,
        delivery.attempts,
        delivery.nextRetryAt ? new Date(delivery.nextRetryAt) : null,
        delivery.completedAt ? new Date(delivery.completedAt) : null,
        delivery.durationMs || null,
        delivery.connectionId || null,
      ],
    );

    return this.mappers.mapDeliveryRow(result.rows[0]);
  }

  async getDelivery(id: string): Promise<WebhookDelivery | null> {
    const result = await this.pool.query('SELECT * FROM webhook_deliveries WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;

    return this.mappers.mapDeliveryRow(result.rows[0]);
  }

  async getDeliveriesByWebhook(
    webhookId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<WebhookDelivery[]> {
    const result = await this.pool.query(
      'SELECT * FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [webhookId, limit, offset],
    );

    return result.rows.map((row) => this.mappers.mapDeliveryRow(row));
  }

  async updateDelivery(
    id: string,
    updates: Partial<Omit<WebhookDelivery, 'id' | 'webhookId' | 'createdAt'>>,
  ): Promise<boolean> {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      params.push(updates.status);
    }
    if (updates.statusCode !== undefined) {
      setClauses.push(`status_code = $${paramIndex++}`);
      params.push(updates.statusCode);
    }
    if (updates.responseBody !== undefined) {
      setClauses.push(`response_body = $${paramIndex++}`);
      params.push(updates.responseBody);
    }
    if (updates.attempts !== undefined) {
      setClauses.push(`attempts = $${paramIndex++}`);
      params.push(updates.attempts);
    }
    if (updates.nextRetryAt !== undefined) {
      setClauses.push(`next_retry_at = $${paramIndex++}`);
      params.push(updates.nextRetryAt ? new Date(updates.nextRetryAt) : null);
    }
    if (updates.completedAt !== undefined) {
      setClauses.push(`completed_at = $${paramIndex++}`);
      params.push(updates.completedAt ? new Date(updates.completedAt) : null);
    }
    if (updates.durationMs !== undefined) {
      setClauses.push(`duration_ms = $${paramIndex++}`);
      params.push(updates.durationMs);
    }

    if (setClauses.length === 0) return true;

    params.push(id);

    const result = await this.pool.query(
      `UPDATE webhook_deliveries SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
      params,
    );

    return (result.rowCount ?? 0) > 0;
  }

  async getRetriableDeliveries(
    limit: number = 100,
    connectionId?: string,
  ): Promise<WebhookDelivery[]> {
    if (connectionId) {
      const result = await this.pool.query(
        `SELECT * FROM webhook_deliveries
         WHERE status = 'retrying'
         AND next_retry_at <= NOW()
         AND connection_id = $2
         ORDER BY next_retry_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit, connectionId],
      );
      return result.rows.map((row) => this.mappers.mapDeliveryRow(row));
    }

    const result = await this.pool.query(
      `SELECT * FROM webhook_deliveries
       WHERE status = 'retrying'
       AND next_retry_at <= NOW()
       ORDER BY next_retry_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );

    return result.rows.map((row) => this.mappers.mapDeliveryRow(row));
  }

  async pruneOldDeliveries(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (connectionId) {
      const result = await this.pool.query(
        'DELETE FROM webhook_deliveries WHERE EXTRACT(EPOCH FROM created_at) * 1000 < $1 AND connection_id = $2',
        [cutoffTimestamp, connectionId],
      );
      return result.rowCount ?? 0;
    }

    const result = await this.pool.query(
      'DELETE FROM webhook_deliveries WHERE EXTRACT(EPOCH FROM created_at) * 1000 < $1',
      [cutoffTimestamp],
    );

    return result.rowCount ?? 0;
  }
}
