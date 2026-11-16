import type { Webhook, WebhookPayload } from '@betterdb/shared';
import { WebhookPayloadFormat, incidentEventUrl } from '@betterdb/shared';

const TITLE_LIMIT = 120;
const SLACK_TEXT_LIMIT = 3000;
const DISCORD_DESCRIPTION_LIMIT = 4096;
const NODE_LIST_LIMIT = 5;
const SLACK_NODE_FIELD_LIMIT = 1900;
const DISCORD_FIELD_VALUE_LIMIT = 1024;
const SHARD_ID_LENGTH = 8;
const ANOMALY_PAGE_EVENTS: ReadonlySet<string> = new Set([
  'anomaly.detected',
  'anomaly.sequence.detected',
  'retry_amplification.detected',
]);
const INCIDENT_LINK_EVENTS: ReadonlySet<string> = new Set([
  'anomaly.detected',
  'anomaly.sequence.detected',
]);

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Defensively pull metric/value/baseline out of any event data shape. */
function summarize(data: Record<string, unknown>): { metric?: string; value?: number; baseline?: number } {
  const metric =
    str(data['metricType']) ?? str(data['metricKind']) ?? str(data['metric']) ?? str(data['thresholdKey']);
  const value =
    num(data['value']) ?? num(data['currentValue']) ?? num(data['currentLatency']) ??
    num(data['currentConnections']) ?? num(data['usedPercent']) ?? num(data['lagSeconds']);
  const baseline =
    num(data['baseline']) ?? num(data['threshold']);
  return { metric, value, baseline };
}

function nodeLabel(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const node = value as Record<string, unknown>;
  const address = str(node['address']);
  if (!address) return undefined;
  const role = str(node['role']);
  const shardId = str(node['shardId']);
  const details = [
    role && role !== 'unknown' ? role : undefined,
    shardId ? `shard ${shardId.slice(0, SHARD_ID_LENGTH)}` : undefined,
    str(node['availabilityZone']),
  ].filter((detail): detail is string => detail !== undefined);
  const label = details.length > 0 ? `${address} (${details.join(', ')})` : address;
  return node['collected'] === false ? `${label}, not collected` : label;
}

function nodeField(data: Record<string, unknown>): { name: string; value: string } | undefined {
  const node = nodeLabel(data['node']);
  if (node) return { name: 'Node', value: node };
  const nodes = (Array.isArray(data['nodes']) ? data['nodes'] : [])
    .map(nodeLabel)
    .filter((label): label is string => label !== undefined);
  if (nodes.length === 0) return undefined;
  const shown = nodes.slice(0, NODE_LIST_LIMIT);
  const rest = nodes.length - shown.length;
  return { name: 'Nodes', value: [...shown, ...(rest > 0 ? [`and ${rest} more`] : [])].join('\n') };
}

/**
 * Event text can carry attacker-controlled strings: an unauthenticated client
 * chooses the username that lands in ACL LOG (`AUTH <!channel> x`), and keys,
 * commands and client names flow into other events. Chat formats interpret
 * markup in that text, so it must be neutralised before rendering.
 *
 * Slack: `&`, `<`, `>` are the only control characters in mrkdwn; escaping
 * them disables `<!channel>`, `<@U123>` and `<https://evil|masked>` links.
 */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Discord: backslash-escape markdown so `[label](url)` masked links and
 * formatting render literally, and break `@everyone`/`@here` with a zero-width
 * space. `allowed_mentions: { parse: [] }` on the body is the hard guarantee
 * that nothing pings; this keeps the visible text honest as well.
 */
export function escapeDiscord(text: string): string {
  return text.replace(/([\\`*_~|>\[\]()])/g, '\\$1').replace(/@(everyone|here)/g, '@\u200b$1');
}

function escapeWithin(text: string, limit: number, escape: (text: string) => string): string {
  let fits = 0;
  let tooLong = text.length + 1;
  while (tooLong - fits > 1) {
    const middle = Math.floor((fits + tooLong) / 2);
    if (escape(text.slice(0, middle)).length <= limit) fits = middle;
    else tooLong = middle;
  }
  return escape(text.slice(0, fits));
}

function instanceLabel(p: WebhookPayload): string {
  const host = p.instance?.host ?? 'unknown';
  const port = p.instance?.port;
  return port ? `${host}:${port}` : host;
}

function titleFor(p: WebhookPayload): string {
  const msg = str(p.data['message']);
  if (msg) return msg.length > TITLE_LIMIT ? `${msg.slice(0, TITLE_LIMIT - 3)}...` : msg;
  return `BetterDB alert: ${p.event}`;
}

function truncatedMessage(p: WebhookPayload): string | undefined {
  const msg = str(p.data['message']);
  return msg && msg.length > TITLE_LIMIT ? msg : undefined;
}

export function formatWebhookBody(
  webhook: Pick<Webhook, 'payloadFormat'>,
  payload: WebhookPayload,
  appBaseUrl?: string,
): string {
  const format = webhook.payloadFormat ?? WebhookPayloadFormat.GENERIC;
  if (format === WebhookPayloadFormat.SLACK) return JSON.stringify(toSlack(payload, appBaseUrl));
  if (format === WebhookPayloadFormat.DISCORD) return JSON.stringify(toDiscord(payload, appBaseUrl));
  return JSON.stringify(payload);
}

export function toSlack(payload: WebhookPayload, appBaseUrl?: string): Record<string, unknown> {
  const s = summarize(payload.data ?? {});
  const title = titleFor(payload);
  const fields: Array<{ type: string; text: string }> = [
    { type: 'mrkdwn', text: `*Event:*\n${escapeSlack(payload.event)}` },
    { type: 'mrkdwn', text: `*Instance:*\n${escapeSlack(instanceLabel(payload))}` },
  ];
  if (s.metric) fields.push({ type: 'mrkdwn', text: `*Metric:*\n${escapeSlack(s.metric)}` });
  if (s.value !== undefined || s.baseline !== undefined) {
    fields.push({
      type: 'mrkdwn',
      text: `*Value / baseline:*\n${s.value ?? '?'} / ${s.baseline ?? '?'}`,
    });
  }
  const node = nodeField(payload.data ?? {});
  if (node) {
    fields.push({
      type: 'mrkdwn',
      text: `*${node.name}:*\n${escapeWithin(node.value, SLACK_NODE_FIELD_LIMIT, escapeSlack)}`,
    });
  }
  const message = truncatedMessage(payload);
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${escapeSlack(title)}*` } },
    ...(message
      ? [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: escapeWithin(message, SLACK_TEXT_LIMIT, escapeSlack) },
          },
        ]
      : []),
    { type: 'section', fields },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<!date^${Math.floor(payload.timestamp / 1000)}^{date_short} {time}|alert time>` }],
    },
  ];
  const link = dashboardLink(payload, appBaseUrl);
  if (link) {
    blocks.push({
      type: 'actions',
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'View in BetterDB' }, url: link }],
    });
  }
  return { text: escapeSlack(title), blocks };
}

const DISCORD_COLORS: Record<string, number> = {
  'instance.down': 0xe5484d,
  'instance.up': 0x30a46c,
  'anomaly.detected': 0xf5a524,
  'anomaly.sequence.detected': 0xf5a524,
  'writes.rejected': 0xe5484d,
  'writes.recovered': 0x30a46c,
};

export function toDiscord(payload: WebhookPayload, appBaseUrl?: string): Record<string, unknown> {
  const s = summarize(payload.data ?? {});
  const title = titleFor(payload);
  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: 'Event', value: escapeDiscord(payload.event), inline: true },
    { name: 'Instance', value: escapeDiscord(instanceLabel(payload)), inline: true },
  ];
  if (s.metric) fields.push({ name: 'Metric', value: escapeDiscord(s.metric), inline: true });
  if (s.value !== undefined || s.baseline !== undefined) {
    fields.push({ name: 'Value / baseline', value: `${s.value ?? '?'} / ${s.baseline ?? '?'}`, inline: true });
  }
  const node = nodeField(payload.data ?? {});
  if (node) {
    fields.push({
      name: node.name,
      value: escapeWithin(node.value, DISCORD_FIELD_VALUE_LIMIT, escapeDiscord),
      inline: false,
    });
  }
  const link = dashboardLink(payload, appBaseUrl);
  const safeTitle = escapeDiscord(title);
  const message = truncatedMessage(payload);
  return {
    content: safeTitle,
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: safeTitle,
        ...(message
          ? { description: escapeWithin(message, DISCORD_DESCRIPTION_LIMIT, escapeDiscord) }
          : {}),
        color: DISCORD_COLORS[payload.event] ?? 0x3e63dd,
        fields,
        timestamp: new Date(payload.timestamp).toISOString(),
        ...(link ? { url: link } : {}),
        footer: { text: 'BetterDB Monitor' },
      },
    ],
  };
}

function dashboardLink(payload: WebhookPayload, appBaseUrl?: string): string | undefined {
  if (!appBaseUrl) return undefined;
  const data = payload.data ?? {};
  const anomalyId = str(data['anomalyId']);
  const at = num(data['timestamp']);
  if (INCIDENT_LINK_EVENTS.has(payload.event) && anomalyId && at !== undefined) {
    return incidentEventUrl(appBaseUrl, anomalyId, at, str(data['connectionId']));
  }
  const base = appBaseUrl.replace(/\/$/, '');
  const path = ANOMALY_PAGE_EVENTS.has(payload.event) ? '/anomalies' : '/dashboard';
  return `${base}${path}`;
}
