export enum Tier {
  community = 'community',
  pro = 'pro',
  enterprise = 'enterprise',
}

export enum SubscriptionStatus {
  active = 'active',
  canceled = 'canceled',
  past_due = 'past_due',
  trialing = 'trialing',
  incomplete = 'incomplete',
  incomplete_expired = 'incomplete_expired',
  unpaid = 'unpaid',
  paused = 'paused',
}

export function isValidTier(value: string): value is Tier {
  return Object.values(Tier).includes(value as Tier);
}

export function parseTier(value: string, fallback: Tier = Tier.community): Tier {
  return isValidTier(value) ? value : fallback;
}

// Feature enum - only features that are LOCKED behind tiers
export enum Feature {
  // Pro+ features (completely locked for Community)
  KEY_ANALYTICS = 'keyAnalytics',
  ANOMALY_DETECTION = 'anomalyDetection',
  ALERTING = 'alerting',
  WORKSPACES = 'workspaces',
  MULTI_INSTANCE = 'multiInstance',
  // Enterprise-only features
  SSO_SAML = 'ssoSaml',
  COMPLIANCE_EXPORT = 'complianceExport',
  RBAC = 'rbac',
  AI_CLOUD = 'aiCloud',
}

export const TIER_FEATURES: Record<Tier, Feature[]> = {
  [Tier.community]: [],
  [Tier.pro]: [
    Feature.KEY_ANALYTICS,
    Feature.ANOMALY_DETECTION,
    Feature.ALERTING,
    Feature.WORKSPACES,
    Feature.MULTI_INSTANCE,
  ],
  [Tier.enterprise]: Object.values(Feature),
};

export const TIER_INSTANCE_LIMITS: Record<Tier, number> = {
  [Tier.community]: 1,
  [Tier.pro]: 10,
  [Tier.enterprise]: Infinity,
};

export interface RetentionLimits {
  dataRetentionDays: number;
  aclRetentionHours: number;
}

export const TIER_RETENTION_LIMITS: Record<Tier, RetentionLimits> = {
  [Tier.community]: { dataRetentionDays: 7, aclRetentionHours: 24 },
  [Tier.pro]: { dataRetentionDays: 90, aclRetentionHours: 90 * 24 },
  [Tier.enterprise]: { dataRetentionDays: 365, aclRetentionHours: 365 * 24 },
};

export interface EntitlementResponse {
  valid: boolean;
  tier: Tier;
  features?: Feature[]; // Optional - will be derived from tier if not provided
  instanceLimit: number;
  retentionLimits: RetentionLimits;
  expiresAt: string | null;
  customer?: {
    id: string;
    name: string | null;
    email: string;
  };
  error?: string;
}

export interface EntitlementRequest {
  licenseKey: string;
  stats?: Record<string, any>;
}
