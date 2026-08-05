import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';

/**
 * Downstream statuses that are caused by — and meaningful to — the end user:
 * validation, conflict, not-found, unprocessable, rate-limit. These are safe to
 * forward. Everything else (notably 401/403, which mean OUR service credential
 * to entitlement is bad, and any 5xx) is an infra fault, not the caller's, so it
 * is logged and surfaced as a generic 502 without leaking the downstream body.
 */
const FORWARDABLE_ENTITLEMENT_STATUSES = new Set([400, 404, 409, 422, 429]);

/**
 * Pull a human-readable message out of an entitlement error response. Nest's
 * ValidationPipe returns `{ message: string | string[], error, statusCode }`;
 * fall back to the raw text, or undefined if the body is empty.
 */
function extractEntitlementError(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.message;
    if (Array.isArray(message)) return message.join('; ');
    if (typeof message === 'string') return message;
  } catch {
    // Non-JSON body — fall through to the raw text.
  }
  return body;
}

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
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.apiKey}`,
        ...(options?.headers as Record<string, string> | undefined),
      };
      // Only declare a JSON content-type when there is a body. Entitlement's
      // Fastify rejects bodyless requests (e.g. DELETE) that set
      // Content-Type: application/json with a 400.
      if (options?.body !== undefined && headers['Content-Type'] === undefined) {
        headers['Content-Type'] = 'application/json';
      }

      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        // Forward only client-caused validation-type errors with their real
        // status + message (e.g. an invalid instance name → 400), so the caller
        // gets an actionable error instead of an opaque 500. Auth failures
        // (401/403 — our entitlement credential) and 5xx are infra faults: log
        // them server-side and return a generic 502 that leaks no internal body.
        if (FORWARDABLE_ENTITLEMENT_STATUSES.has(response.status)) {
          const message = extractEntitlementError(body) ?? `Entitlement API error (${response.status})`;
          throw new HttpException(message, response.status);
        }
        this.logger.error(`Entitlement API ${response.status} for ${path}: ${body}`);
        throw new HttpException('Upstream provisioning service error', HttpStatus.BAD_GATEWAY);
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

  async listValkeyInstances(tenantId: string) {
    return this.request<any[]>(
      `/valkey-instances?tenantId=${encodeURIComponent(tenantId)}`,
    );
  }

  async createValkeyInstance(data: { tenantId: string; name: string; maxmemory?: string }) {
    return this.request<any>('/valkey-instances', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getValkeyInstanceCredentials(id: string, tenantId: string) {
    return this.request<any>(
      `/valkey-instances/${id}/credentials?tenantId=${encodeURIComponent(tenantId)}`,
    );
  }

  async deleteValkeyInstance(id: string, tenantId: string) {
    return this.request<any>(
      `/valkey-instances/${id}?tenantId=${encodeURIComponent(tenantId)}`,
      { method: 'DELETE' },
    );
  }
}
