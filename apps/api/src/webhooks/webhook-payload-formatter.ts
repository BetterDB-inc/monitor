import type { Webhook, WebhookPayload } from '@betterdb/shared';
import { WebhookPayloadFormat } from '@betterdb/shared';
import {
  incidentAction,
  incidentDedupKey,
  incidentSeverity,
  pagerDutyChangeEventsUrl,
  PAGERDUTY_CHANGE_EVENTS,
  type IncidentSeverity,
} from './webhook-incident';

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

/**
 * Microsoft Teams: square brackets are the only markdown characters the
 * Teams clients reliably honour a backslash escape for (other escapes render
 * the backslash literally on mobile), and escaping them is enough to stop
 * `[label](url)` masked links. Mentions need an explicit `msteams.entities`
 * block, which these cards never send, so `<at>` text cannot ping anyone.
 */
export function escapeTeams(text: string): string {
  return text.replace(/([\[\]])/g, '\\$1');
}

/**
 * Google Chat: `<users/all>` pings the whole space and `<https://x|label>` is
 * a masked link in message text, and card text accepts a subset of HTML.
 * Swapping the angle brackets for single guillemets disables all three
 * without hiding any character of the original text.
 */
export function escapeGoogleChat(text: string): string {
  return text.replace(/</g, '\u2039').replace(/>/g, '\u203a');
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
  webhook: Pick<Webhook, 'payloadFormat' | 'routingKey'>,
  payload: WebhookPayload,
  appBaseUrl?: string,
): string {
  const format = webhook.payloadFormat ?? WebhookPayloadFormat.GENERIC;
  if (format === WebhookPayloadFormat.SLACK) return JSON.stringify(toSlack(payload, appBaseUrl));
  if (format === WebhookPayloadFormat.DISCORD) return JSON.stringify(toDiscord(payload, appBaseUrl));
  if (format === WebhookPayloadFormat.PAGERDUTY) {
    return JSON.stringify(toPagerDuty(payload, webhook.routingKey ?? '', appBaseUrl));
  }
  if (format === WebhookPayloadFormat.TEAMS) return JSON.stringify(toTeams(payload, appBaseUrl));
  if (format === WebhookPayloadFormat.GOOGLE_CHAT) return JSON.stringify(toGoogleChat(payload, appBaseUrl));
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
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${escapeSlack(title)}*` } },
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
  const link = dashboardLink(payload, appBaseUrl);
  const safeTitle = escapeDiscord(title);
  return {
    content: safeTitle,
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: safeTitle,
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

/**
 * Where and what to POST for one delivery. Only PagerDuty change events
 * (config.changed, acl.modified) go somewhere other than webhook.url: the
 * Change Events endpoint of the same PagerDuty region.
 */
export function renderWebhookRequest(
  webhook: Pick<Webhook, 'url' | 'payloadFormat' | 'routingKey'>,
  payload: WebhookPayload,
  appBaseUrl?: string,
): { url: string; body: string } {
  if (webhook.payloadFormat === WebhookPayloadFormat.PAGERDUTY && PAGERDUTY_CHANGE_EVENTS.has(payload.event)) {
    const changeUrl = pagerDutyChangeEventsUrl(webhook.url);
    if (changeUrl !== null) {
      return {
        url: changeUrl,
        body: JSON.stringify(toPagerDutyChange(payload, webhook.routingKey ?? '', appBaseUrl)),
      };
    }
  }
  return { url: webhook.url, body: formatWebhookBody(webhook, payload, appBaseUrl) };
}

/** PagerDuty caps payload.summary at 1024 characters. */
const PAGERDUTY_SUMMARY_MAX = 1024;

/**
 * PagerDuty Events API v2 event. Openers and standalone alerts `trigger`;
 * resolvers (instance.up, writes.recovered, failover.completed) `resolve` the
 * incident their opener raised, via the shared dedup_key. A resolve only
 * needs routing_key, event_action and dedup_key.
 */
export function toPagerDuty(
  payload: WebhookPayload,
  routingKey: string,
  appBaseUrl?: string,
): Record<string, unknown> {
  const dedupKey = incidentDedupKey(payload);
  if (incidentAction(payload.event) === 'resolve') {
    return { routing_key: routingKey, event_action: 'resolve', dedup_key: dedupKey };
  }

  const link = dashboardLink(payload, appBaseUrl);
  const body: Record<string, unknown> = {
    routing_key: routingKey,
    event_action: 'trigger',
    dedup_key: dedupKey,
    payload: {
      summary: titleFor(payload).slice(0, PAGERDUTY_SUMMARY_MAX),
      source: instanceLabel(payload),
      severity: incidentSeverity(payload),
      timestamp: new Date(payload.timestamp).toISOString(),
      component: payload.instance?.connectionId ?? 'betterdb-monitor',
      group: 'betterdb',
      class: payload.event,
      custom_details: { event: payload.event, instance: payload.instance, ...(payload.data ?? {}) },
    },
    client: 'BetterDB Monitor',
  };
  if (link) {
    body['client_url'] = link;
    body['links'] = [{ href: link, text: 'View in BetterDB' }];
  }
  return body;
}

/** PagerDuty Change Events API body: recorded on the service timeline, never pages. */
export function toPagerDutyChange(
  payload: WebhookPayload,
  routingKey: string,
  appBaseUrl?: string,
): Record<string, unknown> {
  const link = dashboardLink(payload, appBaseUrl);
  return {
    routing_key: routingKey,
    payload: {
      summary: titleFor(payload).slice(0, PAGERDUTY_SUMMARY_MAX),
      timestamp: new Date(payload.timestamp).toISOString(),
      source: instanceLabel(payload),
      custom_details: { event: payload.event, instance: payload.instance, ...(payload.data ?? {}) },
    },
    ...(link ? { links: [{ href: link, text: 'View in BetterDB' }] } : {}),
  };
}

/**
 * Body for POST /webhooks/:id/test on a PagerDuty webhook. Always an `info`
 * trigger on a per-webhook test key, so a test never lands on (or resolves)
 * a real incident; the dispatcher resolves it right after.
 */
export function pagerDutyTestEvent(
  routingKey: string,
  webhookId: string,
  action: 'trigger' | 'resolve',
  payload: WebhookPayload,
): Record<string, unknown> {
  const dedupKey = `betterdb:test:${webhookId}`;
  if (action === 'resolve') {
    return { routing_key: routingKey, event_action: 'resolve', dedup_key: dedupKey };
  }
  return {
    routing_key: routingKey,
    event_action: 'trigger',
    dedup_key: dedupKey,
    payload: {
      summary: 'BetterDB Monitor test event (resolves automatically)',
      source: instanceLabel(payload),
      severity: 'info',
      timestamp: new Date(payload.timestamp).toISOString(),
      group: 'betterdb',
      class: 'test',
      custom_details: { test: true, webhookId },
    },
    client: 'BetterDB Monitor',
  };
}

const TEAMS_COLORS: Record<IncidentSeverity, string> = {
  critical: 'Attention',
  error: 'Attention',
  warning: 'Warning',
  info: 'Default',
};

/**
 * Microsoft Teams Workflows ("When a Teams webhook request is received") and
 * legacy incoming webhooks both accept a message envelope with one Adaptive
 * Card attachment. Version 1.4 is the newest every Teams client renders.
 */
export function toTeams(payload: WebhookPayload, appBaseUrl?: string): Record<string, unknown> {
  const s = summarize(payload.data ?? {});
  const title = escapeTeams(titleFor(payload));
  const resolved = incidentAction(payload.event) === 'resolve';
  const facts: Array<{ title: string; value: string }> = [
    { title: 'Event', value: escapeTeams(payload.event) },
    { title: 'Instance', value: escapeTeams(instanceLabel(payload)) },
  ];
  if (s.metric) facts.push({ title: 'Metric', value: escapeTeams(s.metric) });
  if (s.value !== undefined || s.baseline !== undefined) {
    facts.push({ title: 'Value / baseline', value: `${s.value ?? '?'} / ${s.baseline ?? '?'}` });
  }
  facts.push({ title: 'Time', value: new Date(payload.timestamp).toISOString() });

  const link = dashboardLink(payload, appBaseUrl);
  const card: Record<string, unknown> = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    msteams: { width: 'Full' },
    body: [
      {
        type: 'TextBlock',
        text: title,
        weight: 'Bolder',
        size: 'Medium',
        wrap: true,
        color: resolved ? 'Good' : TEAMS_COLORS[incidentSeverity(payload)],
      },
      { type: 'FactSet', facts },
    ],
  };
  if (link) {
    card['actions'] = [{ type: 'Action.OpenUrl', title: 'View in BetterDB', url: link }];
  }

  return {
    type: 'message',
    attachments: [
      { contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card },
    ],
  };
}

/**
 * Google Chat space webhook (Apps > Webhooks). `text` drives the notification
 * and the plain-text fallback; the card carries the same fields as the other
 * chat formats. The cardId is per event so Chat never merges two alerts.
 */
export function toGoogleChat(payload: WebhookPayload, appBaseUrl?: string): Record<string, unknown> {
  const s = summarize(payload.data ?? {});
  const title = escapeGoogleChat(titleFor(payload));
  const resolved = incidentAction(payload.event) === 'resolve';
  const widgets: unknown[] = [
    { decoratedText: { topLabel: 'Event', text: escapeGoogleChat(payload.event) } },
    { decoratedText: { topLabel: 'Instance', text: escapeGoogleChat(instanceLabel(payload)) } },
  ];
  if (s.metric) widgets.push({ decoratedText: { topLabel: 'Metric', text: escapeGoogleChat(s.metric) } });
  if (s.value !== undefined || s.baseline !== undefined) {
    widgets.push({ decoratedText: { topLabel: 'Value / baseline', text: `${s.value ?? '?'} / ${s.baseline ?? '?'}` } });
  }
  widgets.push({ decoratedText: { topLabel: 'Time', text: new Date(payload.timestamp).toISOString() } });

  const link = dashboardLink(payload, appBaseUrl);
  if (link) {
    widgets.push({
      buttonList: { buttons: [{ text: 'View in BetterDB', onClick: { openLink: { url: link } } }] },
    });
  }

  return {
    text: title,
    cardsV2: [
      {
        cardId: `betterdb-${payload.id ?? payload.timestamp}`,
        card: {
          header: {
            title,
            subtitle: resolved ? 'Resolved · BetterDB Monitor' : `${incidentSeverity(payload)} · BetterDB Monitor`,
          },
          sections: [{ widgets }],
        },
      },
    ],
  };
}
