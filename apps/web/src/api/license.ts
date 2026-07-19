import { fetchApi } from './client';
import type { Tier, Feature } from '@betterdb/shared';

export type LicenseSource = 'online' | 'cached' | 'persisted-jwt' | 'offline-token' | 'community';

export interface LicenseStatus {
  tier: Tier;
  valid: boolean;
  features: Feature[];
  expiresAt: string | null;
  customer?: {
    name: string;
    email: string;
  };
  source?: LicenseSource;
  mode?: 'online' | 'offline';
  instanceLimit?: number;
  offlineExpiresAt?: string | null;
  // True only when the offline token is the sole authority (no key) — the
  // instance genuinely makes no outbound calls. An offline `source` can also
  // mean fallback-while-online-key-configured, where telemetry stays on.
  airGapped?: boolean;
  clockRollbackSuspected?: boolean;
}

export interface LicenseActivateResponse extends LicenseStatus {
  activatedAt: string;
  // Offline activation with an online key configured stores the token as
  // fallback only — the reported tier is the still-active online one.
  fallbackOnly?: boolean;
  message?: string;
}

export const licenseApi = {
  async getStatus(): Promise<LicenseStatus> {
    return fetchApi<LicenseStatus>('/license/status');
  },

  async activate(key: string): Promise<LicenseActivateResponse> {
    return fetchApi<LicenseActivateResponse>('/license/activate', {
      method: 'POST',
      body: JSON.stringify({ key }),
    });
  },

  async activateOffline(token: string): Promise<LicenseActivateResponse> {
    return fetchApi<LicenseActivateResponse>('/license/activate-offline', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  },
};
