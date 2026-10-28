import { WebhookEventType, openingEventFor, type WebhookPayload } from '@betterdb/shared';

/** PagerDuty Events API v2 severities; also drives the Teams card colour. */
export type IncidentSeverity = 'critical' | 'error' | 'warning' | 'info';

const SEVERITIES: ReadonlySet<string> = new Set(['critical', 'error', 'warning', 'info']);

/**
 * Default severity per event. A Record over the enum, so adding a webhook
 * event without deciding how loudly it pages is a compile error.
 */
export const EVENT_SEVERITY: Readonly<Record<WebhookEventType, IncidentSeverity>> = {
  [WebhookEventType.INSTANCE_DOWN]: 'critical',
  [WebhookEventType.INSTANCE_UP]: 'info',
  [WebhookEventType.MEMORY_CRITICAL]: 'critical',
  [WebhookEventType.CONNECTION_CRITICAL]: 'critical',
  [WebhookEventType.WRITES_REJECTED]: 'critical',
  [WebhookEventType.WRITES_RECOVERED]: 'info',
  [WebhookEventType.ANOMALY_DETECTED]: 'warning',
  [WebhookEventType.SLOWLOG_THRESHOLD]: 'warning',
  [WebhookEventType.LATENCY_SPIKE]: 'warning',
  [WebhookEventType.CONNECTION_SPIKE]: 'warning',
  [WebhookEventType.CLIENT_BLOCKED]: 'warning',
  [WebhookEventType.ACL_VIOLATION]: 'warning',
  [WebhookEventType.ACL_MODIFIED]: 'info',
  [WebhookEventType.CONFIG_CHANGED]: 'info',
  [WebhookEventType.REPLICATION_LAG]: 'error',
  [WebhookEventType.CLUSTER_FAILOVER]: 'error',
  [WebhookEventType.CLUSTER_BUS_CORRUPTION]: 'critical',
  [WebhookEventType.CLUSTER_DEMOTED_WRITES]: 'critical',
  [WebhookEventType.FAILOVER_STARTED]: 'warning',
  [WebhookEventType.FAILOVER_COMPLETED]: 'info',
  [WebhookEventType.DATA_LOSS_DETECTED]: 'critical',
  [WebhookEventType.LATENCY_REGRESSION_DETECTED]: 'warning',
  [WebhookEventType.AUDIT_POLICY_VIOLATION]: 'warning',
  [WebhookEventType.COMPLIANCE_ALERT]: 'warning',
  [WebhookEventType.METRIC_FORECAST_LIMIT]: 'warning',
  [WebhookEventType.SCALING_READINESS_LOW]: 'warning',
  [WebhookEventType.KV_CACHE_HIT_RATE_LOW]: 'warning',
  [WebhookEventType.KV_CACHE_EVICTION_RISK]: 'warning',
  [WebhookEventType.INFERENCE_SLA_BREACH]: 'error',
  [WebhookEventType.CVE_CRITICAL_DETECTED]: 'error',
  [WebhookEventType.CVE_KEV_DETECTED]: 'critical',
  [WebhookEventType.MONITOR_SESSION_STARTED]: 'info',
  [WebhookEventType.MONITOR_SESSION_COMPLETED]: 'info',
  [WebhookEventType.MONITOR_SESSION_TRUNCATED]: 'info',
  [WebhookEventType.MONITOR_SESSION_SKIPPED]: 'info',
  [WebhookEventType.MONITOR_TRIGGER_CREATED]: 'info',
};

/**
 * Severity for one delivery. Events that already grade themselves
 * (anomaly.detected, writes.rejected, cluster.demoted.writes) carry a
 * `data.severity`; it wins when it is one of the four PagerDuty values.
 */
export function incidentSeverity(payload: WebhookPayload): IncidentSeverity {
  const own = payload.data?.['severity'];
  if (typeof own === 'string' && SEVERITIES.has(own)) return own as IncidentSeverity;
  return EVENT_SEVERITY[payload.event] ?? 'warning';
}

/** Resolving events (instance.up, writes.recovered, failover.completed) close the incident their opener raised. */
export function incidentAction(event: WebhookEventType): 'trigger' | 'resolve' {
  return openingEventFor(event) === undefined ? 'trigger' : 'resolve';
}

/** PagerDuty caps dedup_key at 255 characters. */
const MAX_DEDUP_KEY_LENGTH = 255;

/**
 * Stable incident key: one open incident per connection and condition. A
 * resolver maps to its opener's key, so instance.up resolves the incident
 * instance.down opened. A threshold alert that re-arms after 24h dedupes into
 * the incident that is still open instead of paging again. anomaly.detected
 * is further split per metric so unrelated anomalies stay separate.
 */
export function incidentDedupKey(payload: WebhookPayload): string {
  const condition = openingEventFor(payload.event) ?? payload.event;
  const scope = payload.instance?.connectionId ?? stringField(payload.data, 'connectionId') ?? 'global';
  const parts = ['betterdb', scope, condition];
  if (payload.event === WebhookEventType.ANOMALY_DETECTED) {
    const metric = stringField(payload.data, 'metricType');
    if (metric !== undefined) parts.push(metric);
  }
  return parts.join(':').slice(0, MAX_DEDUP_KEY_LENGTH);
}

function stringField(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Changes made to the database or its access control. On a PagerDuty
 * webhook they go to the Change Events API, which records them on the
 * service timeline next to the incidents they may explain, instead of
 * opening an incident of their own.
 */
export const PAGERDUTY_CHANGE_EVENTS: ReadonlySet<WebhookEventType> = new Set([
  WebhookEventType.CONFIG_CHANGED,
  WebhookEventType.ACL_MODIFIED,
]);

const PAGERDUTY_EVENTS_HOST = /^events(\.eu)?\.pagerduty\.com$/;

/**
 * Change Events endpoint on the same PagerDuty service region as an Events
 * API v2 URL, or null when the URL is not PagerDuty's own enqueue endpoint
 * (a proxy or relay), in which case change events are sent as info alerts.
 */
export function pagerDutyChangeEventsUrl(eventsUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(eventsUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !PAGERDUTY_EVENTS_HOST.test(parsed.hostname)) return null;
  if (parsed.pathname.replace(/\/+$/, '') !== '/v2/enqueue') return null;
  return `${parsed.origin}/v2/change/enqueue`;
}
