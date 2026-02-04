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
  WEBHOOK_OPERATIONAL_EVENTS = 'webhookOperationalEvents',
  WEBHOOK_CUSTOM_HEADERS = 'webhookCustomHeaders',
  WEBHOOK_DELIVERY_PAYLOAD = 'webhookDeliveryPayload',
  WEBHOOK_CONFIGURABLE_RETRY = 'webhookConfigurableRetry',
  // Enterprise-only features
  SSO_SAML = 'ssoSaml',
  COMPLIANCE_EXPORT = 'complianceExport',
  RBAC = 'rbac',
  AI_CLOUD = 'aiCloud',
  WEBHOOK_COMPLIANCE_EVENTS = 'webhookComplianceEvents',
  WEBHOOK_DLQ = 'webhookDlq',
}

export const TIER_FEATURES: Record<Tier, Feature[]> = {
  [Tier.community]: [],
  [Tier.pro]: [
    Feature.KEY_ANALYTICS,
    Feature.ANOMALY_DETECTION,
    Feature.ALERTING,
    Feature.WORKSPACES,
    Feature.MULTI_INSTANCE,
    Feature.WEBHOOK_OPERATIONAL_EVENTS,
    Feature.WEBHOOK_CUSTOM_HEADERS,
    Feature.WEBHOOK_DELIVERY_PAYLOAD,
    Feature.WEBHOOK_CONFIGURABLE_RETRY,
  ],
  [Tier.enterprise]: Object.values(Feature),
};

export interface EntitlementResponse {
  valid: boolean;
  tier: Tier;
  features?: Feature[]; // Optional - will be derived from tier if not provided
  expiresAt: string | null;
  customer?: {
    id: string;
    name: string | null;
    email: string;
  };
  error?: string;
  
  // Version info (optional, for update notifications)
  latestVersion?: string;
  releaseUrl?: string;
}

export interface EntitlementRequest {
  licenseKey?: string;
  instanceId: string;
  eventType: 'license_check' | 'telemetry_ping';
  stats?: Record<string, any>;
  // Telemetry-specific fields (for telemetry_ping)
  version?: string;
  platform?: string;
  arch?: string;
  nodeVersion?: string;
  tier?: string;
}
