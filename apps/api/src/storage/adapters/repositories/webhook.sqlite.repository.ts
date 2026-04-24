import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import {
  Webhook,
  WebhookDelivery,
  WebhookEventType,
} from '../../../common/interfaces/storage-port.interface';
import { RowMappers } from '../base-sql.adapter';

export class WebhookSqliteRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly mappers: RowMappers,
  ) {}

  async createWebhook(webhook: Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>): Promise<Webhook> {
    const id = randomUUID();
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO webhooks (id, name, url, secret, enabled, events, headers, retry_policy, delivery_config, alert_config, thresholds, connection_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      webhook.name,
      webhook.url,
      webhook.secret,
      webhook.enabled ? 1 : 0,
      JSON.stringify(webhook.events),
      JSON.stringify(webhook.headers || {}),
      JSON.stringify(webhook.retryPolicy),
      webhook.deliveryConfig ? JSON.stringify(webhook.deliveryConfig) : null,
      webhook.alertConfig ? JSON.stringify(webhook.alertConfig) : null,
      webhook.thresholds ? JSON.stringify(webhook.thresholds) : null,
      webhook.connectionId || null,
      now,
      now,
    );

    return {
      id,
      name: webhook.name,
      url: webhook.url,
      secret: webhook.secret,
      enabled: webhook.enabled,
      events: webhook.events,
      headers: webhook.headers,
      retryPolicy: webhook.retryPolicy,
      deliveryConfig: webhook.deliveryConfig,
      alertConfig: webhook.alertConfig,
      thresholds: webhook.thresholds,
      connectionId: webhook.connectionId,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getWebhook(id: string): Promise<Webhook | null> {
    const row = this.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as unknown;
    if (!row) return null;

    return this.mappers.mapWebhookRow(row);
  }

  async getWebhooksByInstance(connectionId?: string): Promise<Webhook[]> {
    if (connectionId) {
      const rows = this.db
        .prepare(
          'SELECT * FROM webhooks WHERE connection_id = ? OR connection_id IS NULL ORDER BY created_at DESC',
        )
        .all(connectionId) as unknown[];
      return rows.map((row) => this.mappers.mapWebhookRow(row));
    }

    // No connectionId provided - only return global webhooks (not scoped to any connection)
    const rows = this.db
      .prepare('SELECT * FROM webhooks WHERE connection_id IS NULL ORDER BY created_at DESC')
      .all() as unknown[];
    return rows.map((row) => this.mappers.mapWebhookRow(row));
  }

  async getWebhooksByEvent(event: WebhookEventType, connectionId?: string): Promise<Webhook[]> {
    if (connectionId) {
      // Return webhooks scoped to this connection OR global webhooks (no connectionId)
      const rows = this.db
        .prepare(
          'SELECT * FROM webhooks WHERE enabled = 1 AND (connection_id = ? OR connection_id IS NULL)',
        )
        .all(connectionId) as unknown[];
      return rows
        .map((row) => this.mappers.mapWebhookRow(row))
        .filter((webhook) => webhook.events.includes(event));
    }

    // No connectionId provided - only return global webhooks (not scoped to any connection)
    const rows = this.db
      .prepare('SELECT * FROM webhooks WHERE enabled = 1 AND connection_id IS NULL')
      .all() as unknown[];
    return rows
      .map((row) => this.mappers.mapWebhookRow(row))
      .filter((webhook) => webhook.events.includes(event));
  }

  async updateWebhook(
    id: string,
    updates: Partial<Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<Webhook | null> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      params.push(updates.name);
    }
    if (updates.url !== undefined) {
      setClauses.push('url = ?');
      params.push(updates.url);
    }
    if (updates.secret !== undefined) {
      setClauses.push('secret = ?');
      params.push(updates.secret);
    }
    if (updates.enabled !== undefined) {
      setClauses.push('enabled = ?');
      params.push(updates.enabled ? 1 : 0);
    }
    if (updates.events !== undefined) {
      setClauses.push('events = ?');
      params.push(JSON.stringify(updates.events));
    }
    if (updates.headers !== undefined) {
      setClauses.push('headers = ?');
      params.push(JSON.stringify(updates.headers));
    }
    if (updates.retryPolicy !== undefined) {
      setClauses.push('retry_policy = ?');
      params.push(JSON.stringify(updates.retryPolicy));
    }
    if (updates.deliveryConfig !== undefined) {
      setClauses.push('delivery_config = ?');
      params.push(JSON.stringify(updates.deliveryConfig));
    }
    if (updates.alertConfig !== undefined) {
      setClauses.push('alert_config = ?');
      params.push(JSON.stringify(updates.alertConfig));
    }
    if (updates.thresholds !== undefined) {
      setClauses.push('thresholds = ?');
      params.push(JSON.stringify(updates.thresholds));
    }
    if (updates.connectionId !== undefined) {
      setClauses.push('connection_id = ?');
      params.push(updates.connectionId);
    }

    if (setClauses.length === 0) {
      return this.getWebhook(id);
    }

    setClauses.push('updated_at = ?');
    params.push(Date.now());
    params.push(id);

    const stmt = this.db.prepare(`UPDATE webhooks SET ${setClauses.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);

    if (result.changes === 0) return null;
    return this.getWebhook(id);
  }

  async deleteWebhook(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
    return result.changes > 0;
  }

  async createDelivery(
    delivery: Omit<WebhookDelivery, 'id' | 'createdAt'>,
  ): Promise<WebhookDelivery> {
    const id = randomUUID();
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO webhook_deliveries (
        id, webhook_id, event_type, payload, status, status_code, response_body,
        attempts, next_retry_at, completed_at, duration_ms, connection_id, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      delivery.webhookId,
      delivery.eventType,
      JSON.stringify(delivery.payload),
      delivery.status,
      delivery.statusCode || null,
      delivery.responseBody || null,
      delivery.attempts,
      delivery.nextRetryAt || null,
      delivery.completedAt || null,
      delivery.durationMs || null,
      delivery.connectionId || null,
      now,
    );

    return {
      id,
      webhookId: delivery.webhookId,
      eventType: delivery.eventType,
      payload: delivery.payload,
      status: delivery.status,
      statusCode: delivery.statusCode,
      responseBody: delivery.responseBody,
      attempts: delivery.attempts,
      nextRetryAt: delivery.nextRetryAt,
      connectionId: delivery.connectionId,
      createdAt: now,
      completedAt: delivery.completedAt,
      durationMs: delivery.durationMs,
    };
  }

  async getDelivery(id: string): Promise<WebhookDelivery | null> {
    const row = this.db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id) as unknown;
    if (!row) return null;

    return this.mappers.mapDeliveryRow(row);
  }

  async getDeliveriesByWebhook(
    webhookId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<WebhookDelivery[]> {
    const rows = this.db
      .prepare(
        'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      )
      .all(webhookId, limit, offset) as unknown[];

    return rows.map((row) => this.mappers.mapDeliveryRow(row));
  }

  async updateDelivery(
    id: string,
    updates: Partial<Omit<WebhookDelivery, 'id' | 'webhookId' | 'createdAt'>>,
  ): Promise<boolean> {
    const setClauses: string[] = [];
    const params:unknown[] = [];

    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      params.push(updates.status);
    }
    if (updates.statusCode !== undefined) {
      setClauses.push('status_code = ?');
      params.push(updates.statusCode);
    }
    if (updates.responseBody !== undefined) {
      setClauses.push('response_body = ?');
      params.push(updates.responseBody);
    }
    if (updates.attempts !== undefined) {
      setClauses.push('attempts = ?');
      params.push(updates.attempts);
    }
    if (updates.nextRetryAt !== undefined) {
      setClauses.push('next_retry_at = ?');
      params.push(updates.nextRetryAt !== undefined ? updates.nextRetryAt : null);
    }
    if (updates.completedAt !== undefined) {
      setClauses.push('completed_at = ?');
      params.push(updates.completedAt !== undefined ? updates.completedAt : null);
    }
    if (updates.durationMs !== undefined) {
      setClauses.push('duration_ms = ?');
      params.push(updates.durationMs);
    }

    if (setClauses.length === 0) return true;

    params.push(id);

    const stmt = this.db.prepare(
      `UPDATE webhook_deliveries SET ${setClauses.join(', ')} WHERE id = ?`,
    );
    const result = stmt.run(...params);

    return result.changes > 0;
  }

  async getRetriableDeliveries(
    limit: number = 100,
    connectionId?: string,
  ): Promise<WebhookDelivery[]> {
    const now = Date.now();

    if (connectionId) {
      const rows = this.db
        .prepare(
          `SELECT * FROM webhook_deliveries
         WHERE status = 'retrying' AND next_retry_at <= ? AND connection_id = ?
         ORDER BY next_retry_at ASC
         LIMIT ?`,
        )
        .all(now, connectionId, limit) as unknown[];
      return rows.map((row) => this.mappers.mapDeliveryRow(row));
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM webhook_deliveries
       WHERE status = 'retrying' AND next_retry_at <= ?
       ORDER BY next_retry_at ASC
       LIMIT ?`,
      )
      .all(now, limit) as unknown[];

    return rows.map((row) => this.mappers.mapDeliveryRow(row));
  }

  async pruneOldDeliveries(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    if (connectionId) {
      const result = this.db
        .prepare('DELETE FROM webhook_deliveries WHERE created_at < ? AND connection_id = ?')
        .run(cutoffTimestamp, connectionId);
      return result.changes;
    }

    const result = this.db
      .prepare('DELETE FROM webhook_deliveries WHERE created_at < ?')
      .run(cutoffTimestamp);
    return result.changes;
  }
}
