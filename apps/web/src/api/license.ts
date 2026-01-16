import { fetchApi } from './client';
import type { Tier, Feature, RetentionLimits } from '@betterdb/shared';

export interface LicenseStatus {
  tier: Tier;
  valid: boolean;
  features: Feature[];
  instanceLimit: number;
  retentionLimits: RetentionLimits;
  expiresAt: string | null;
  customer?: {
    name: string;
    email: string;
  };
}

export const licenseApi = {
  async getStatus(): Promise<LicenseStatus> {
    return fetchApi<LicenseStatus>('/license/status');
  },
};
