import {
  WebhookEventType,
  WebhookPayloadFormat,
  WEBHOOK_RESOLVING_EVENT,
  openingEventFor,
  resolvingEventFor,
  suggestPayloadFormatForUrl,
  isValidPagerDutyRoutingKey,
  type WebhookPayload,
} from '@betterdb/shared';
import {
  escapeGoogleChat,
  escapeTeams,
  formatWebhookBody,
  pagerDutyTestEvent,
  renderWebhookRequest,
  toGoogleChat,
  toPagerDuty,
  toPagerDutyChange,
  toTeams,
} from '../webhook-payload-formatter';
import {
  EVENT_SEVERITY,
  PAGERDUTY_CHANGE_EVENTS,
  PAGERDUTY_OPENERS_WITH_RESOLVER,
  incidentAction,
  incidentDedupKey,
  incidentSeverity,
  pagerDutyChangeEventsUrl,
} from '../webhook-incident';

const ROUTING_KEY = 'R0123456789ABCDEFGHIJKLMNOPQRSTU';
const APP = 'https://betterdb.example.com';

function payload(overrides: Partial<WebhookPayload> = {}): WebhookPayload {
  return {
    id: 'p-1',
    event: WebhookEventType.INSTANCE_DOWN,
    timestamp: 1706457600000,
    instance: { host: 'valkey.example.com', port: 6379, connectionId: 'conn-1' },
    data: { message: 'Database instance unreachable: ECONNREFUSED', reason: 'ECONNREFUSED' },
    ...overrides,
  };
}

describe('webhook lifecycle pairs', () => {
  it('maps each opener to its resolver and back', () => {
    expect(resolvingEventFor(WebhookEventType.INSTANCE_DOWN)).toBe(WebhookEventType.INSTANCE_UP);
    expect(resolvingEventFor(WebhookEventType.WRITES_REJECTED)).toBe(WebhookEventType.WRITES_RECOVERED);
    expect(resolvingEventFor(WebhookEventType.FAILOVER_STARTED)).toBe(WebhookEventType.FAILOVER_COMPLETED);
    for (const [opening, resolving] of Object.entries(WEBHOOK_RESOLVING_EVENT)) {
      expect(openingEventFor(resolving as WebhookEventType)).toBe(opening);
    }
  });

  it('returns undefined for events outside a pair', () => {
    expect(resolvingEventFor(WebhookEventType.MEMORY_CRITICAL)).toBeUndefined();
    expect(openingEventFor(WebhookEventType.MEMORY_CRITICAL)).toBeUndefined();
    expect(openingEventFor(WebhookEventType.INSTANCE_DOWN)).toBeUndefined();
  });
});

describe('incident helpers', () => {
  it('assigns a default severity to every webhook event', () => {
    for (const event of Object.values(WebhookEventType)) {
      expect(['critical', 'error', 'warning', 'info']).toContain(EVENT_SEVERITY[event]);
    }
  });

  it('lets an event that grades itself override the default severity', () => {
    expect(incidentSeverity(payload({ event: WebhookEventType.WRITES_REJECTED, data: { severity: 'warning' } }))).toBe(
      'warning',
    );
    expect(incidentSeverity(payload({ event: WebhookEventType.ANOMALY_DETECTED, data: { severity: 'critical' } }))).toBe(
      'critical',
    );
    // Not a PagerDuty severity: ignored.
    expect(incidentSeverity(payload({ event: WebhookEventType.MEMORY_CRITICAL, data: { severity: 'high' } }))).toBe(
      'critical',
    );
  });

  it('resolves only on the closing event of a pair', () => {
    expect(incidentAction(WebhookEventType.INSTANCE_DOWN)).toBe('trigger');
    expect(incidentAction(WebhookEventType.INSTANCE_UP)).toBe('resolve');
    expect(incidentAction(WebhookEventType.WRITES_RECOVERED)).toBe('resolve');
    expect(incidentAction(WebhookEventType.FAILOVER_COMPLETED)).toBe('resolve');
    expect(incidentAction(WebhookEventType.MEMORY_CRITICAL)).toBe('trigger');
  });

  it('gives an opener and its resolver the same dedup key, scoped per connection', () => {
    const down = incidentDedupKey(payload());
    const up = incidentDedupKey(payload({ event: WebhookEventType.INSTANCE_UP }));
    expect(down).toBe('betterdb:conn-1:instance.down');
    expect(up).toBe(down);
    const other = incidentDedupKey(
      payload({ instance: { host: 'b', port: 6380, connectionId: 'conn-2' } }),
    );
    expect(other).not.toBe(down);
  });

  it('splits anomaly incidents per metric and falls back to data.connectionId, then global', () => {
    expect(
      incidentDedupKey(payload({ event: WebhookEventType.ANOMALY_DETECTED, data: { metricType: 'memory_used' } })),
    ).toBe('betterdb:conn-1:anomaly.detected:memory_used');
    expect(
      incidentDedupKey(payload({ instance: { host: 'h', port: 1 }, data: { connectionId: 'from-data' } })),
    ).toBe('betterdb:from-data:instance.down');
    expect(incidentDedupKey(payload({ instance: undefined, data: {} }))).toBe('betterdb:global:instance.down');
  });

  it('caps the dedup key at 255 characters', () => {
    const key = incidentDedupKey(payload({ instance: { host: 'h', port: 1, connectionId: 'x'.repeat(400) } }));
    expect(key).toHaveLength(255);
  });
});

describe('PagerDuty format', () => {
  it('triggers with the Events API v2 shape', () => {
    const body = toPagerDuty(payload(), ROUTING_KEY, APP);
    expect(body).toEqual({
      routing_key: ROUTING_KEY,
      event_action: 'trigger',
      dedup_key: 'betterdb:conn-1:instance.down',
      payload: {
        summary: 'Database instance unreachable: ECONNREFUSED',
        source: 'valkey.example.com:6379',
        severity: 'critical',
        timestamp: '2024-01-28T16:00:00.000Z',
        component: 'conn-1',
        group: 'betterdb',
        class: 'instance.down',
        custom_details: {
          event: 'instance.down',
          instance: { host: 'valkey.example.com', port: 6379, connectionId: 'conn-1' },
          message: 'Database instance unreachable: ECONNREFUSED',
          reason: 'ECONNREFUSED',
        },
      },
      client: 'BetterDB Monitor',
      client_url: `${APP}/dashboard`,
      links: [{ href: `${APP}/dashboard`, text: 'View in BetterDB' }],
    });
  });

  it('resolves with only routing_key, event_action and dedup_key', () => {
    expect(toPagerDuty(payload({ event: WebhookEventType.INSTANCE_UP }), ROUTING_KEY, APP)).toEqual({
      routing_key: ROUTING_KEY,
      event_action: 'resolve',
      dedup_key: 'betterdb:conn-1:instance.down',
    });
  });

  it('omits links without a public app URL and truncates the summary to 1024 characters', () => {
    const body = toPagerDuty(
      payload({ data: { message: 'x'.repeat(5000) } }),
      ROUTING_KEY,
    ) as { payload: { summary: string }; links?: unknown; client_url?: unknown };
    expect(body.links).toBeUndefined();
    expect(body.client_url).toBeUndefined();
    expect(body.payload.summary.length).toBeLessThanOrEqual(1024);
  });

  it('is selected by formatWebhookBody and carries the stored routing key', () => {
    const body = JSON.parse(
      formatWebhookBody({ payloadFormat: WebhookPayloadFormat.PAGERDUTY, routingKey: ROUTING_KEY }, payload()),
    );
    expect(body.routing_key).toBe(ROUTING_KEY);
    expect(body.event_action).toBe('trigger');
  });

  it('builds an info-level test trigger and resolve on a per-webhook test key', () => {
    const trigger = pagerDutyTestEvent(ROUTING_KEY, 'wh-1', 'trigger', payload()) as {
      dedup_key: string;
      payload: { severity: string };
    };
    expect(trigger.dedup_key).toBe('betterdb:test:wh-1');
    expect(trigger.payload.severity).toBe('info');
    expect(pagerDutyTestEvent(ROUTING_KEY, 'wh-1', 'resolve', payload())).toEqual({
      routing_key: ROUTING_KEY,
      event_action: 'resolve',
      dedup_key: 'betterdb:test:wh-1',
    });
  });
});

describe('PagerDuty change events', () => {
  const configChanged = payload({
    event: WebhookEventType.CONFIG_CHANGED,
    data: { configKey: 'maxmemory', oldValue: '1gb', newValue: '512mb', message: 'maxmemory changed from 1gb to 512mb' },
  });

  it('covers config and ACL changes only', () => {
    expect([...PAGERDUTY_CHANGE_EVENTS].sort()).toEqual([WebhookEventType.ACL_MODIFIED, WebhookEventType.CONFIG_CHANGED].sort());
  });

  it('derives the Change Events endpoint for PagerDuty US and EU enqueue URLs only', () => {
    expect(pagerDutyChangeEventsUrl('https://events.pagerduty.com/v2/enqueue')).toBe(
      'https://events.pagerduty.com/v2/change/enqueue',
    );
    expect(pagerDutyChangeEventsUrl('https://events.eu.pagerduty.com/v2/enqueue/')).toBe(
      'https://events.eu.pagerduty.com/v2/change/enqueue',
    );
    expect(pagerDutyChangeEventsUrl('http://events.pagerduty.com/v2/enqueue')).toBeNull();
    expect(pagerDutyChangeEventsUrl('https://relay.example.com/v2/enqueue')).toBeNull();
    expect(pagerDutyChangeEventsUrl('https://events.pagerduty.com.evil.example/v2/enqueue')).toBeNull();
    expect(pagerDutyChangeEventsUrl('https://events.pagerduty.com/integration/abc/enqueue')).toBeNull();
    expect(pagerDutyChangeEventsUrl('not a url')).toBeNull();
  });

  it('builds a change event that never pages', () => {
    expect(toPagerDutyChange(configChanged, ROUTING_KEY, APP)).toEqual({
      routing_key: ROUTING_KEY,
      payload: {
        summary: 'maxmemory changed from 1gb to 512mb',
        timestamp: '2024-01-28T16:00:00.000Z',
        source: 'valkey.example.com:6379',
        custom_details: {
          event: 'config.changed',
          instance: { host: 'valkey.example.com', port: 6379, connectionId: 'conn-1' },
          configKey: 'maxmemory',
          oldValue: '1gb',
          newValue: '512mb',
          message: 'maxmemory changed from 1gb to 512mb',
        },
      },
      links: [{ href: `${APP}/dashboard`, text: 'View in BetterDB' }],
    });
  });

  it('routes change events to the Change Events API and everything else to the webhook URL', () => {
    const webhook = {
      url: 'https://events.pagerduty.com/v2/enqueue',
      payloadFormat: WebhookPayloadFormat.PAGERDUTY,
      routingKey: ROUTING_KEY,
    };
    const change = renderWebhookRequest(webhook, configChanged);
    expect(change.url).toBe('https://events.pagerduty.com/v2/change/enqueue');
    expect(JSON.parse(change.body).event_action).toBeUndefined();

    const alert = renderWebhookRequest(webhook, payload());
    expect(alert.url).toBe(webhook.url);
    expect(JSON.parse(alert.body).event_action).toBe('trigger');
  });

  it('sends a change event as an info alert when the URL is a relay, and leaves other formats alone', () => {
    const relayed = renderWebhookRequest(
      { url: 'https://relay.example.com/pd', payloadFormat: WebhookPayloadFormat.PAGERDUTY, routingKey: ROUTING_KEY },
      configChanged,
    );
    expect(relayed.url).toBe('https://relay.example.com/pd');
    expect(JSON.parse(relayed.body)).toMatchObject({ event_action: 'trigger', payload: { severity: 'info' } });

    const slack = renderWebhookRequest(
      { url: 'https://hooks.slack.com/services/x', payloadFormat: WebhookPayloadFormat.SLACK },
      configChanged,
    );
    expect(slack.url).toBe('https://hooks.slack.com/services/x');
    expect(JSON.parse(slack.body).blocks).toBeDefined();
  });
});

describe('Microsoft Teams format', () => {
  type Card = {
    type: string;
    version: string;
    body: Array<{ type: string; text?: string; color?: string; facts?: Array<{ title: string; value: string }> }>;
    actions?: Array<{ type: string; url: string }>;
  };
  const cardOf = (body: Record<string, unknown>): Card => {
    const attachments = body['attachments'] as Array<{ contentType: string; content: Card }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    return attachments[0].content;
  };

  it('wraps an Adaptive Card 1.4 in a message envelope', () => {
    const body = toTeams(payload(), APP);
    expect(body['type']).toBe('message');
    const card = cardOf(body);
    expect(card.type).toBe('AdaptiveCard');
    expect(card.version).toBe('1.4');
    expect(card.body[0].text).toBe('Database instance unreachable: ECONNREFUSED');
    expect(card.body[0].color).toBe('Attention');
    expect(card.body[1].facts?.map((fact) => fact.title)).toEqual(['Event', 'Instance', 'Time']);
    expect(card.actions).toEqual([{ type: 'Action.OpenUrl', title: 'View in BetterDB', url: `${APP}/dashboard` }]);
  });

  it('adds metric and value facts when the event carries them', () => {
    const card = cardOf(
      toTeams(
        payload({
          event: WebhookEventType.ANOMALY_DETECTED,
          data: { metricType: 'latency', value: 42, baseline: 10, message: 'Latency anomaly', severity: 'warning' },
        }),
      ),
    );
    expect(card.body[1].facts).toEqual(
      expect.arrayContaining([
        { title: 'Metric', value: 'latency' },
        { title: 'Value / baseline', value: '42 / 10' },
      ]),
    );
    expect(card.body[0].color).toBe('Warning');
    expect(card.actions).toBeUndefined();
  });

  it('colours recovery events green', () => {
    expect(cardOf(toTeams(payload({ event: WebhookEventType.WRITES_RECOVERED, data: {} }))).body[0].color).toBe('Good');
  });

  it('breaks masked links in untrusted text', () => {
    expect(escapeTeams('[Reset](https://evil.example)')).toBe('\\[Reset\\](https://evil.example)');
    const card = cardOf(
      toTeams(
        payload({
          event: WebhookEventType.CLIENT_BLOCKED,
          data: { message: 'Client blocked: [Reset your password](https://evil.example)' },
        }),
      ),
    );
    expect(card.body[0].text).not.toMatch(/(^|[^\\])\[Reset your password\]\(/);
  });

  it('is selected by formatWebhookBody', () => {
    const body = JSON.parse(formatWebhookBody({ payloadFormat: WebhookPayloadFormat.TEAMS }, payload()));
    expect(body.type).toBe('message');
  });
});

describe('Google Chat format', () => {
  type ChatCard = {
    cardId: string;
    card: {
      header: { title: string; subtitle: string };
      sections: Array<{ widgets: Array<Record<string, { topLabel?: string; text?: string; buttons?: unknown[] }>> }>;
    };
  };
  const cardOf = (body: Record<string, unknown>): ChatCard => (body['cardsV2'] as ChatCard[])[0];

  it('sends notification text plus a cardsV2 card with the shared fields', () => {
    const body = toGoogleChat(payload(), APP);
    expect(body['text']).toBe('Database instance unreachable: ECONNREFUSED');
    const card = cardOf(body);
    expect(card.cardId).toBe('betterdb-p-1');
    expect(card.card.header).toEqual({
      title: 'Database instance unreachable: ECONNREFUSED',
      subtitle: 'critical · BetterDB Monitor',
    });
    const labels = card.card.sections[0].widgets
      .map((widget) => widget['decoratedText']?.topLabel)
      .filter((label) => label !== undefined);
    expect(labels).toEqual(['Event', 'Instance', 'Time']);
    expect(card.card.sections[0].widgets.at(-1)).toEqual({
      buttonList: { buttons: [{ text: 'View in BetterDB', onClick: { openLink: { url: `${APP}/dashboard` } } }] },
    });
  });

  it('marks recovery events as resolved and omits the button without an app URL', () => {
    const card = cardOf(toGoogleChat(payload({ event: WebhookEventType.INSTANCE_UP, data: { message: 'Database instance recovered' } })));
    expect(card.card.header.subtitle).toBe('Resolved · BetterDB Monitor');
    expect(card.card.sections[0].widgets.some((widget) => 'buttonList' in widget)).toBe(false);
  });

  it('cannot ping the space, mask a link or inject card HTML from untrusted text', () => {
    expect(escapeGoogleChat('<users/all> <https://evil.example|reset> <b>x</b>')).toBe(
      '\u2039users/all\u203a \u2039https://evil.example|reset\u203a \u2039b\u203ax\u2039/b\u203a',
    );
    const body = JSON.stringify(
      toGoogleChat(
        payload({
          event: WebhookEventType.CLIENT_BLOCKED,
          data: { message: 'Client blocked: <users/all> <https://evil.example|Reset your password>' },
        }),
      ),
    );
    expect(body).not.toContain('<users/all>');
    expect(body).not.toContain('<https://evil.example|');
  });

  it('is selected by formatWebhookBody', () => {
    const body = JSON.parse(formatWebhookBody({ payloadFormat: WebhookPayloadFormat.GOOGLE_CHAT }, payload()));
    expect(body.cardsV2).toHaveLength(1);
  });
});

describe('format auto-suggest and routing key shape', () => {
  it('recognises PagerDuty (US and EU) and Teams webhook URLs', () => {
    expect(suggestPayloadFormatForUrl('https://events.pagerduty.com/v2/enqueue')).toBe(WebhookPayloadFormat.PAGERDUTY);
    expect(suggestPayloadFormatForUrl('https://events.eu.pagerduty.com/v2/enqueue')).toBe(
      WebhookPayloadFormat.PAGERDUTY,
    );
    expect(
      suggestPayloadFormatForUrl('https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke'),
    ).toBe(WebhookPayloadFormat.TEAMS);
    expect(
      suggestPayloadFormatForUrl(
        'https://default0a1b.2c.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke',
      ),
    ).toBe(WebhookPayloadFormat.TEAMS);
    expect(suggestPayloadFormatForUrl('https://contoso.webhook.office.com/webhookb2/abc')).toBe(
      WebhookPayloadFormat.TEAMS,
    );
    expect(
      suggestPayloadFormatForUrl('https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token=t'),
    ).toBe(WebhookPayloadFormat.GOOGLE_CHAT);
    expect(suggestPayloadFormatForUrl('https://example.com/pagerduty.com/v2/enqueue')).toBeUndefined();
    expect(suggestPayloadFormatForUrl('https://api.example.com/hook')).toBeUndefined();
  });

  it('accepts only 32 alphanumeric characters as a routing key', () => {
    expect(isValidPagerDutyRoutingKey(ROUTING_KEY)).toBe(true);
    expect(isValidPagerDutyRoutingKey(ROUTING_KEY.slice(1))).toBe(false);
    expect(isValidPagerDutyRoutingKey(`${ROUTING_KEY.slice(1)}-`)).toBe(false);
    expect(isValidPagerDutyRoutingKey('R012***')).toBe(false);
  });
});

describe('PAGERDUTY_OPENERS_WITH_RESOLVER', () => {
  it('contains the events that have a resolver and nothing else', () => {
    expect(PAGERDUTY_OPENERS_WITH_RESOLVER.has(WebhookEventType.INSTANCE_DOWN)).toBe(true);
    expect(PAGERDUTY_OPENERS_WITH_RESOLVER.has(WebhookEventType.WRITES_REJECTED)).toBe(true);
    expect(PAGERDUTY_OPENERS_WITH_RESOLVER.has(WebhookEventType.FAILOVER_STARTED)).toBe(true);
    expect(PAGERDUTY_OPENERS_WITH_RESOLVER.has(WebhookEventType.INSTANCE_UP)).toBe(false);
    expect(PAGERDUTY_OPENERS_WITH_RESOLVER.has(WebhookEventType.MEMORY_CRITICAL)).toBe(false);
  });
});

describe('suggestPayloadFormatForUrl host matching', () => {
  it.each([
    'https://prod.logic.azure.com.example.org/workflows/abc',
    'https://evil.example.com/?u=.webhook.office.com/',
    'https://evil.example.com/workflows/x?u=.logic.azure.com',
  ])('does not suggest Teams for spoofed %s', (url) => {
    expect(suggestPayloadFormatForUrl(url)).toBeUndefined();
  });

  it.each([
    ['https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?x=1', WebhookPayloadFormat.TEAMS],
    ['https://contoso.webhook.office.com/webhookb2/abc', WebhookPayloadFormat.TEAMS],
    ['https://chat.googleapis.com/v1/spaces/AAA/messages?key=k', WebhookPayloadFormat.GOOGLE_CHAT],
    ['https://events.eu.pagerduty.com/v2/enqueue', WebhookPayloadFormat.PAGERDUTY],
    ['https://events.pagerduty.com/v2/enqueue', WebhookPayloadFormat.PAGERDUTY],
    ['https://hooks.slack.com/services/T/B/x', WebhookPayloadFormat.SLACK],
    ['https://discord.com/api/webhooks/1/abc', WebhookPayloadFormat.DISCORD],
    ['https://ptb.discord.com/api/webhooks/1/abc', WebhookPayloadFormat.DISCORD],
  ])('suggests the right format for %s', (url, format) => {
    expect(suggestPayloadFormatForUrl(url)).toBe(format);
  });

  it('returns no suggestion for an invalid URL without throwing', () => {
    expect(suggestPayloadFormatForUrl('not a url')).toBeUndefined();
    expect(suggestPayloadFormatForUrl('')).toBeUndefined();
  });
});
