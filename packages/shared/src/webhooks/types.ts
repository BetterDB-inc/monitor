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

export interface Webhook {
  id: string;
  name: string;
  url: string;
  secret?: string;
  enabled: boolean;
  events: WebhookEventType[];
  headers?: Record<string, string>;
  retryPolicy: RetryPolicy;
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
