import { fetchApi } from './client';
import type { Tier, Feature } from '@betterdb/shared';

export interface LicenseStatus {
  tier: Tier;
  valid: boolean;
  features: Feature[];
  expiresAt: string | null;
  customer?: {
    name: string;
    email: string;
  };
}

export interface LicenseActivateResponse extends LicenseStatus {
  activatedAt: string;
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
};
