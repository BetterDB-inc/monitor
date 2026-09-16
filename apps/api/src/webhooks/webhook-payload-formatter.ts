import type { Webhook, WebhookPayload } from '@betterdb/shared';
import { WebhookPayloadFormat } from '@betterdb/shared';

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

function instanceLabel(p: WebhookPayload): string {
  const host = p.instance?.host ?? 'unknown';
  const port = p.instance?.port;
  return port ? `${host}:${port}` : host;
}

function titleFor(p: WebhookPayload): string {
  const msg = str(p.data['message']);
  if (msg) return msg.length > 120 ? `${msg.slice(0, 117)}...` : msg;
  return `BetterDB alert: ${p.event}`;
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
    { type: 'mrkdwn', text: `*Event:*\n${payload.event}` },
    { type: 'mrkdwn', text: `*Instance:*\n${instanceLabel(payload)}` },
  ];
  if (s.metric) fields.push({ type: 'mrkdwn', text: `*Metric:*\n${s.metric}` });
  if (s.value !== undefined || s.baseline !== undefined) {
    fields.push({
      type: 'mrkdwn',
      text: `*Value / baseline:*\n${s.value ?? '?'} / ${s.baseline ?? '?'}`,
    });
  }
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${title}*` } },
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
  return { text: title, blocks };
}

const DISCORD_COLORS: Record<string, number> = {
  'instance.down': 0xe5484d,
  'instance.up': 0x30a46c,
  'anomaly.detected': 0xf5a524,
};

export function toDiscord(payload: WebhookPayload, appBaseUrl?: string): Record<string, unknown> {
  const s = summarize(payload.data ?? {});
  const title = titleFor(payload);
  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: 'Event', value: payload.event, inline: true },
    { name: 'Instance', value: instanceLabel(payload), inline: true },
  ];
  if (s.metric) fields.push({ name: 'Metric', value: s.metric, inline: true });
  if (s.value !== undefined || s.baseline !== undefined) {
    fields.push({ name: 'Value / baseline', value: `${s.value ?? '?'} / ${s.baseline ?? '?'}`, inline: true });
  }
  const link = dashboardLink(payload, appBaseUrl);
  return {
    content: title,
    embeds: [
      {
        title,
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
  const base = appBaseUrl.replace(/\/$/, '');
  const path = payload.event === 'anomaly.detected' ? '/anomalies' : '/dashboard';
  return `${base}${path}`;
}
