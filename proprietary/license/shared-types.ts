export enum Tier {
  community = 'community',
  pro = 'pro',
  enterprise = 'enterprise',
}

export enum Feature {
  KEY_ANALYTICS = 'keyAnalytics',
  AI_ASSISTANT = 'aiAssistant',
  HISTORICAL_DATA = 'historicalData',
  ALERTING = 'alerting',
  AUDIT_EXPORT = 'auditExport',
  SSO_SAML = 'ssoSaml',
  RBAC = 'rbac',
  MULTI_INSTANCE = 'multiInstance',
}

export const TIER_FEATURES: Record<Tier, Feature[]> = {
  [Tier.community]: [],
  [Tier.pro]: [
    Feature.KEY_ANALYTICS,
    Feature.HISTORICAL_DATA,
    Feature.ALERTING,
    Feature.AUDIT_EXPORT,
    Feature.MULTI_INSTANCE,
  ],
  [Tier.enterprise]: Object.values(Feature),
};

export const TIER_INSTANCE_LIMITS: Record<Tier, number> = {
  [Tier.community]: 1,
  [Tier.pro]: 10,
  [Tier.enterprise]: Infinity,
};

export interface EntitlementResponse {
  valid: boolean;
  tier: Tier;
  features: Feature[];
  instanceLimit: number;
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
  instanceId?: string;
  stats?: Record<string, any>;
}
