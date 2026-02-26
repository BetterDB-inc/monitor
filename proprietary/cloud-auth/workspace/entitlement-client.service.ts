import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class EntitlementClientService {
  private readonly logger = new Logger(EntitlementClientService.name);
  private readonly apiUrl: string;
  private readonly apiKey: string;

  constructor() {
    this.apiUrl = process.env.ENTITLEMENT_API_URL || '';
    this.apiKey = process.env.ENTITLEMENT_API_KEY || '';
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          ...options?.headers,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Entitlement API ${response.status}: ${body}`);
      }

      const text = await response.text();
      return text ? JSON.parse(text) : ({} as T);
    } finally {
      clearTimeout(timeout);
    }
  }

  async getMembers(tenantId: string) {
    return this.request<any[]>(`/users/by-tenant/${tenantId}`);
  }

  async createInvitation(data: { tenantId: string; email: string; role: string; invitedBy: string }) {
    return this.request<any>('/invitations', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async listInvitations(tenantId: string) {
    return this.request<any[]>(`/invitations?tenantId=${encodeURIComponent(tenantId)}`);
  }

  async revokeInvitation(id: string) {
    return this.request<any>(`/invitations/${id}`, {
      method: 'DELETE',
    });
  }

  async checkInvitation(email: string, tenantId?: string) {
    let url = `/invitations/check?email=${encodeURIComponent(email)}`;
    if (tenantId) {
      url += `&tenantId=${encodeURIComponent(tenantId)}`;
    }
    return this.request<any>(url);
  }

  async acceptInvitation(id: string, userId: string) {
    return this.request<any>(`/invitations/${id}/accept`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  async deleteUser(userId: string) {
    return this.request<any>(`/users/${userId}`, {
      method: 'DELETE',
    });
  }
}
