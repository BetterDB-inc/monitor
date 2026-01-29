export enum WebhookEventType {
  INSTANCE_DOWN = 'instance.down',
  INSTANCE_UP = 'instance.up',
  MEMORY_CRITICAL = 'memory.critical',
  CONNECTION_CRITICAL = 'connection.critical',
  ANOMALY_DETECTED = 'anomaly.detected',
  SLOWLOG_THRESHOLD = 'slowlog.threshold',
  LATENCY_SPIKE = 'latency.spike',
  CONNECTION_SPIKE = 'connection.spike',
  CLIENT_BLOCKED = 'client.blocked',
  ACL_VIOLATION = 'acl.violation',
  ACL_MODIFIED = 'acl.modified',
  CONFIG_CHANGED = 'config.changed',
  REPLICATION_LAG = 'replication.lag',
  CLUSTER_FAILOVER = 'cluster.failover',
  AUDIT_POLICY_VIOLATION = 'audit.policy.violation',
  COMPLIANCE_ALERT = 'compliance.alert',
}

// Injection tokens for proprietary webhook services
export const WEBHOOK_EVENTS_PRO_SERVICE = 'WEBHOOK_EVENTS_PRO_SERVICE';
export const WEBHOOK_EVENTS_ENTERPRISE_SERVICE = 'WEBHOOK_EVENTS_ENTERPRISE_SERVICE';

export const FREE_EVENTS: WebhookEventType[] = [
  WebhookEventType.INSTANCE_DOWN,
  WebhookEventType.INSTANCE_UP,
  WebhookEventType.MEMORY_CRITICAL,
  WebhookEventType.CONNECTION_CRITICAL,
  WebhookEventType.CLIENT_BLOCKED,
];

export const PRO_EVENTS: WebhookEventType[] = [
  ...FREE_EVENTS,
  WebhookEventType.ANOMALY_DETECTED,
  WebhookEventType.SLOWLOG_THRESHOLD,
  WebhookEventType.REPLICATION_LAG,
  WebhookEventType.CLUSTER_FAILOVER,
  WebhookEventType.LATENCY_SPIKE,
  WebhookEventType.CONNECTION_SPIKE,
];

export const ENTERPRISE_EVENTS: WebhookEventType[] = [
  ...PRO_EVENTS,
  WebhookEventType.AUDIT_POLICY_VIOLATION,
  WebhookEventType.COMPLIANCE_ALERT,
  WebhookEventType.ACL_VIOLATION,
  WebhookEventType.ACL_MODIFIED,
  WebhookEventType.CONFIG_CHANGED,
];

// ============================================================================
// Tier System for Event Subscription Gating
// ============================================================================

import { Tier } from '../license/types';
export { Tier };

/**
 * Maps each webhook event to its minimum required tier
 */
export const WEBHOOK_EVENT_TIERS: Record<WebhookEventType, Tier> = {
  // Community tier events
  [WebhookEventType.INSTANCE_DOWN]: Tier.community,
  [WebhookEventType.INSTANCE_UP]: Tier.community,
  [WebhookEventType.MEMORY_CRITICAL]: Tier.community,
  [WebhookEventType.CONNECTION_CRITICAL]: Tier.community,
  [WebhookEventType.CLIENT_BLOCKED]: Tier.community,

  // Pro tier events
  [WebhookEventType.ANOMALY_DETECTED]: Tier.pro,
  [WebhookEventType.SLOWLOG_THRESHOLD]: Tier.pro,
  [WebhookEventType.REPLICATION_LAG]: Tier.pro,
  [WebhookEventType.CLUSTER_FAILOVER]: Tier.pro,
  [WebhookEventType.LATENCY_SPIKE]: Tier.pro,
  [WebhookEventType.CONNECTION_SPIKE]: Tier.pro,

  // Enterprise tier events
  [WebhookEventType.AUDIT_POLICY_VIOLATION]: Tier.enterprise,
  [WebhookEventType.COMPLIANCE_ALERT]: Tier.enterprise,
  [WebhookEventType.ACL_VIOLATION]: Tier.enterprise,
  [WebhookEventType.ACL_MODIFIED]: Tier.enterprise,
  [WebhookEventType.CONFIG_CHANGED]: Tier.enterprise,
};

/**
 * Tier hierarchy for comparison
 */
const TIER_HIERARCHY: Record<Tier, number> = {
  [Tier.community]: 0,
  [Tier.pro]: 1,
  [Tier.enterprise]: 2,
};

/**
 * Get the minimum tier required for a specific event
 */
export function getRequiredTierForEvent(event: WebhookEventType): Tier {
  return WEBHOOK_EVENT_TIERS[event];
}

/**
 * Check if a specific event is allowed for the given tier
 */
export function isEventAllowedForTier(event: WebhookEventType, userTier: Tier): boolean {
  const requiredTier = WEBHOOK_EVENT_TIERS[event];
  return TIER_HIERARCHY[userTier] >= TIER_HIERARCHY[requiredTier];
}

/**
 * Get all events allowed for a specific tier (including lower tiers)
 */
export function getEventsForTier(tier: Tier): WebhookEventType[] {
  switch (tier) {
    case Tier.community:
      return [...FREE_EVENTS];
    case Tier.pro:
      return [...PRO_EVENTS];
    case Tier.enterprise:
      return [...ENTERPRISE_EVENTS];
  }
}

/**
 * Get events that are locked (not available) for a specific tier
 */
export function getLockedEventsForTier(tier: Tier): WebhookEventType[] {
  const allowedEvents = getEventsForTier(tier);
  return Object.values(WebhookEventType).filter(
    (event) => !allowedEvents.includes(event)
  );
}

/**
 * Group all events by their tier category for UI display
 */
export function getEventsByTierCategory(): Record<Tier, WebhookEventType[]> {
  return {
    [Tier.community]: [...FREE_EVENTS],
    [Tier.pro]: PRO_EVENTS.filter((e) => !FREE_EVENTS.includes(e)),
    [Tier.enterprise]: ENTERPRISE_EVENTS.filter((e) => !PRO_EVENTS.includes(e)),
  };
}

/**
 * Validate that all requested events are allowed for the user's tier
 * Returns array of disallowed events (empty if all allowed)
 */
export function validateEventsForTier(
  events: WebhookEventType[],
  userTier: Tier
): WebhookEventType[] {
  return events.filter((event) => !isEventAllowedForTier(event, userTier));
}

export enum DeliveryStatus {
  PENDING = 'pending',
  SUCCESS = 'success',
  FAILED = 'failed',
  RETRYING = 'retrying',
  DEAD_LETTER = 'dead_letter',
}

export interface RetryPolicy {
  maxRetries: number;
  backoffMultiplier: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  backoffMultiplier: 2,
  initialDelayMs: 1000,
  maxDelayMs: 60000,
};

export interface WebhookDeliveryConfig {
  timeoutMs?: number;              // Default: 30000
  maxResponseBodyBytes?: number;   // Default: 10000
}

export interface WebhookAlertConfig {
  hysteresisFactor?: number;       // Default: 0.9
}

export interface WebhookThresholds {
  memoryCriticalPercent?: number;      // Default: 90
  connectionCriticalPercent?: number;  // Default: 90
  complianceMemoryPercent?: number;    // Default: 80
  slowlogCount?: number;               // Default: 100
  replicationLagSeconds?: number;      // Default: 10
  latencySpikeMs?: number;             // Default: 0 (baseline)
  connectionSpikeCount?: number;       // Default: 0 (baseline)
}

export interface Webhook {
  id: string;
  name: string;
  url: string;
  secret?: string;
  enabled: boolean;
  events: WebhookEventType[];
  headers?: Record<string, string>;
  retryPolicy: RetryPolicy;
  deliveryConfig?: WebhookDeliveryConfig;
  alertConfig?: WebhookAlertConfig;
  thresholds?: WebhookThresholds;
  createdAt: number;
  updatedAt: number;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventType: WebhookEventType;
  payload: WebhookPayload;
  status: DeliveryStatus;
  statusCode?: number;
  responseBody?: string;
  attempts: number;
  nextRetryAt?: number;
  createdAt: number;
  completedAt?: number;
  durationMs?: number;
}

export interface WebhookPayload {
  id?: string;
  event: WebhookEventType;
  timestamp: number;
  instance?: {
    host: string;
    port: number;
  };
  data: Record<string, any>;
}

// Instance info used across all webhook events
export interface WebhookInstanceInfo {
  host: string;
  port: number;
}

// ============================================================================
// Webhook Events Service Interfaces (for OCV dynamic imports)
// These interfaces allow open source code to safely type proprietary services
// ============================================================================

/**
 * PRO tier webhook events service interface
 * Implemented by proprietary/webhook-pro/webhook-events-pro.service.ts
 */
export interface IWebhookEventsProService {
  dispatchSlowlogThreshold(data: {
    slowlogCount: number;
    threshold: number;
    timestamp: number;
    instance: WebhookInstanceInfo;
  }): Promise<void>;

  dispatchReplicationLag(data: {
    lagSeconds: number;
    threshold: number;
    masterLinkStatus: string;
    timestamp: number;
    instance: WebhookInstanceInfo;
  }): Promise<void>;

  dispatchClusterFailover(data: {
    clusterState: string;
    previousState?: string;
    slotsAssigned: number;
    slotsFailed: number;
    knownNodes: number;
    timestamp: number;
    instance: WebhookInstanceInfo;
  }): Promise<void>;

  dispatchAnomalyDetected(data: {
    anomalyId: string;
    metricType: string;
    severity: string;
    value: number;
    baseline: number;
    threshold: number;
    message: string;
    timestamp: number;
    instance: WebhookInstanceInfo;
  }): Promise<void>;

  dispatchLatencySpike(data: {
    currentLatency: number;
    baseline: number;
    threshold: number;
    timestamp: number;
    instance: WebhookInstanceInfo;
  }): Promise<void>;

  dispatchConnectionSpike(data: {
    currentConnections: number;
    baseline: number;
    threshold: number;
    timestamp: number;
    instance: WebhookInstanceInfo;
  }): Promise<void>;
}

/**
 * ENTERPRISE tier webhook events service interface
 * Implemented by proprietary/webhook-pro/webhook-events-enterprise.service.ts
 */
export interface IWebhookEventsEnterpriseService {
  dispatchComplianceAlert(data: {
    complianceType: string;
    severity: string;
    memoryUsedPercent?: number;
    maxmemoryPolicy?: string;
    message: string;
    timestamp: number;
    instance: WebhookInstanceInfo;
  }): Promise<void>;

  dispatchAuditPolicyViolation(data: {
    username: string;
    clientInfo: string;
    violationType: 'command' | 'key';
    violatedCommand?: string;
    violatedKey?: string;
    count: number;
    timestamp: number;
    instance: WebhookInstanceInfo;
  }): Promise<void>;

  dispatchAclViolation(data: {
    username: string;
    command: string;
    key?: string;
    reason: string;
    timestamp: number;
    instance: WebhookInstanceInfo;
  }): Promise<void>;

  dispatchAclModified(data: {
    modifiedBy?: string;
    changeType: 'user_added' | 'user_removed' | 'user_updated' | 'permissions_changed';
    affectedUser?: string;
    timestamp: number;
    instance: WebhookInstanceInfo;
  }): Promise<void>;

  dispatchConfigChanged(data: {
    configKey: string;
    oldValue?: string;
    newValue: string;
    modifiedBy?: string;
    timestamp: number;
    instance: WebhookInstanceInfo;
  }): Promise<void>;
}
