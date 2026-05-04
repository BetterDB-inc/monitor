import { randomUUID } from 'crypto';
import {
  Webhook,
  WebhookDelivery,
  WebhookEventType,
} from '../../../common/interfaces/storage-port.interface';

export class WebhookMemoryRepository {
  private webhooks: Map<string, Webhook> = new Map();
  private deliveries: Map<string, WebhookDelivery> = new Map();

  constructor(private readonly maxDeliveriesPerWebhook: number) {}

  clear(): void {
    this.webhooks.clear();
    this.deliveries.clear();
  }

  async createWebhook(webhook: Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>): Promise<Webhook> {
    const id = randomUUID();
    const now = Date.now();
    const newWebhook: Webhook = {
      id,
      ...webhook,
      createdAt: now,
      updatedAt: now,
    };
    this.webhooks.set(id, newWebhook);
    return { ...newWebhook };
  }

  async getWebhook(id: string): Promise<Webhook | null> {
    const webhook = this.webhooks.get(id);
    return webhook ? { ...webhook } : null;
  }

  async getWebhooksByInstance(connectionId?: string): Promise<Webhook[]> {
    let webhooks = Array.from(this.webhooks.values());
    if (connectionId) {
      webhooks = webhooks.filter((w) => w.connectionId === connectionId || !w.connectionId);
    } else {
      // No connectionId provided - only return global webhooks (not scoped to any connection)
      webhooks = webhooks.filter((w) => !w.connectionId);
    }
    return webhooks.sort((a, b) => b.createdAt - a.createdAt).map((w) => ({ ...w }));
  }

  async getWebhooksByEvent(event: WebhookEventType, connectionId?: string): Promise<Webhook[]> {
    let webhooks = Array.from(this.webhooks.values()).filter(
      (w) => w.enabled && w.events.includes(event),
    );
    if (connectionId) {
      // Return webhooks scoped to this connection OR global webhooks (no connectionId)
      webhooks = webhooks.filter((w) => w.connectionId === connectionId || !w.connectionId);
    } else {
      // No connectionId provided - only return global webhooks (not scoped to any connection)
      webhooks = webhooks.filter((w) => !w.connectionId);
    }
    return webhooks.map((w) => ({ ...w }));
  }

  async updateWebhook(
    id: string,
    updates: Partial<Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<Webhook | null> {
    const webhook = this.webhooks.get(id);
    if (!webhook) return null;

    // Filter out undefined values to prevent overwriting existing fields
    const definedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, value]) => value !== undefined),
    );

    const updated: Webhook = {
      ...webhook,
      ...definedUpdates,
      id,
      createdAt: webhook.createdAt,
      updatedAt: Date.now(),
    };
    this.webhooks.set(id, updated);
    return { ...updated };
  }

  async deleteWebhook(id: string): Promise<boolean> {
    const deleted = this.webhooks.delete(id);
    if (deleted) {
      const deliveriesToDelete = Array.from(this.deliveries.entries())
        .filter(([_, d]) => d.webhookId === id)
        .map(([id]) => id);
      deliveriesToDelete.forEach((deliveryId) => this.deliveries.delete(deliveryId));
    }
    return deleted;
  }

  async createDelivery(
    delivery: Omit<WebhookDelivery, 'id' | 'createdAt'>,
  ): Promise<WebhookDelivery> {
    const now = Date.now();
    const id = randomUUID();
    const newDelivery: WebhookDelivery = {
      id,
      ...delivery,
      createdAt: now,
    };
    this.deliveries.set(id, newDelivery);

    const webhookDeliveries = Array.from(this.deliveries.values())
      .filter((d) => d.webhookId === delivery.webhookId)
      .sort((a, b) => b.createdAt - a.createdAt);

    if (webhookDeliveries.length > this.maxDeliveriesPerWebhook) {
      const toDelete = webhookDeliveries.slice(this.maxDeliveriesPerWebhook);
      toDelete.forEach((d) => this.deliveries.delete(d.id));
    }

    return { ...newDelivery };
  }

  async getDelivery(id: string): Promise<WebhookDelivery | null> {
    const delivery = this.deliveries.get(id);
    return delivery ? { ...delivery } : null;
  }

  async getDeliveriesByWebhook(
    webhookId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<WebhookDelivery[]> {
    return Array.from(this.deliveries.values())
      .filter((d) => d.webhookId === webhookId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(offset, offset + limit)
      .map((d) => ({ ...d }));
  }

  async updateDelivery(
    id: string,
    updates: Partial<Omit<WebhookDelivery, 'id' | 'webhookId' | 'createdAt'>>,
  ): Promise<boolean> {
    const delivery = this.deliveries.get(id);
    if (!delivery) return false;

    const updated: WebhookDelivery = {
      ...delivery,
      ...updates,
      id,
      webhookId: delivery.webhookId,
      createdAt: delivery.createdAt,
    };
    this.deliveries.set(id, updated);
    return true;
  }

  async getRetriableDeliveries(
    limit: number = 100,
    connectionId?: string,
  ): Promise<WebhookDelivery[]> {
    const now = Date.now();
    let deliveries = Array.from(this.deliveries.values()).filter(
      (d) => d.status === 'retrying' && d.nextRetryAt && d.nextRetryAt <= now,
    );
    if (connectionId) {
      deliveries = deliveries.filter((d) => d.connectionId === connectionId);
    }
    return deliveries
      .sort((a, b) => (a.nextRetryAt || 0) - (b.nextRetryAt || 0))
      .slice(0, limit)
      .map((d) => ({ ...d }));
  }

  async pruneOldDeliveries(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    const before = this.deliveries.size;
    Array.from(this.deliveries.entries())
      .filter(
        ([_, d]) =>
          d.createdAt < cutoffTimestamp && (!connectionId || d.connectionId === connectionId),
      )
      .forEach(([id]) => this.deliveries.delete(id));
    return before - this.deliveries.size;
  }
}
