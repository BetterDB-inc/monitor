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
  BULK_DELETE = 'bulkDelete',
  ANOMALY_DETECTION = 'anomalyDetection',
  ALERTING = 'alerting',
  WORKSPACES = 'workspaces',
  MULTI_INSTANCE = 'multiInstance',
  WEBHOOK_OPERATIONAL_EVENTS = 'webhookOperationalEvents',
  WEBHOOK_CUSTOM_HEADERS = 'webhookCustomHeaders',
  WEBHOOK_DELIVERY_PAYLOAD = 'webhookDeliveryPayload',
  WEBHOOK_CONFIGURABLE_RETRY = 'webhookConfigurableRetry',
  INFERENCE_SLA = 'inferenceSla',
  CACHE_INTELLIGENCE = 'cacheIntelligence',
  MONITOR_ANOMALY_TRIGGER = 'monitorAnomalyTrigger',
  MONITOR_SCHEDULED_CAPTURES = 'monitorScheduledCaptures',
  MONITOR_CAPTURE_DIFF = 'monitorCaptureDiff',
  // Enterprise-only features
  SSO_SAML = 'ssoSaml',
  COMPLIANCE_EXPORT = 'complianceExport',
  RBAC = 'rbac',
  AI_CLOUD = 'aiCloud',
  WEBHOOK_COMPLIANCE_EVENTS = 'webhookComplianceEvents',
  WEBHOOK_DLQ = 'webhookDlq',
  MIGRATION_EXECUTION = 'migrationExecution',
}

export const TIER_FEATURES: Record<Tier, Feature[]> = {
  [Tier.community]: [],
  [Tier.pro]: [
    Feature.KEY_ANALYTICS,
    Feature.BULK_DELETE,
    Feature.ANOMALY_DETECTION,
    Feature.ALERTING,
    Feature.WORKSPACES,
    Feature.MULTI_INSTANCE,
    Feature.WEBHOOK_OPERATIONAL_EVENTS,
    Feature.WEBHOOK_CUSTOM_HEADERS,
    Feature.WEBHOOK_DELIVERY_PAYLOAD,
    Feature.WEBHOOK_CONFIGURABLE_RETRY,
    Feature.MIGRATION_EXECUTION,
    Feature.INFERENCE_SLA,
    Feature.CACHE_INTELLIGENCE,
    Feature.MONITOR_ANOMALY_TRIGGER,
    Feature.MONITOR_SCHEDULED_CAPTURES,
    Feature.MONITOR_CAPTURE_DIFF,
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

  // Signed entitlement JWT (RS256) — verifiable offline with the monitor's
  // embedded public keys. Absent from legacy servers and community tier.
  token?: string;
  instanceLimit?: number;

  // Version info (optional, for update notifications)
  latestVersion?: string;
  releaseUrl?: string;
}

// Issuer expected in every signed license token
export const LICENSE_JWT_ISSUER = 'betterdb-entitlement';

// Where the currently active entitlement came from
export type LicenseSource =
  | 'online'
  | 'cached'
  | 'persisted-jwt'
  | 'offline-token'
  | 'community';

/**
 * Claims carried by both online entitlement tokens and offline license
 * tokens. `sub` is the license id — the raw license key is never embedded.
 */
export interface LicenseTokenClaims {
  iss: string;
  sub: string;
  jti: string;
  tier: Tier;
  features?: Feature[];
  customer?: {
    id?: string;
    name: string | null;
    email: string;
  };
  instanceLimit: number;
  mode: 'online' | 'offline';
  // The LICENSE's real expiry (ISO), independent of this token's `exp` (which is
  // just the token's short lifetime). null = perpetual license. Absent on tokens
  // minted before this claim existed — consumers fall back to `exp` then.
  licenseExpiresAt?: string | null;
  iat: number;
  exp: number;
}

export interface EntitlementRequest {
  licenseKey?: string;
  tenantId?: string;
  instanceId: string;
  eventType: 'license_check' | 'telemetry_ping';
  stats?: Record<string, any>;
  // Telemetry-specific fields (for telemetry_ping)
  version?: string;
  platform?: string;
  arch?: string;
  nodeVersion?: string;
  tier?: string;
  deploymentMode?: 'cloud' | 'self-hosted';
}
