import { formatWebhookBody, toSlack, toDiscord } from '../webhook-payload-formatter';
import { WebhookEventType, WebhookPayloadFormat, type WebhookPayload } from '@betterdb/shared';

const base: WebhookPayload = {
  id: '1',
  event: WebhookEventType.ANOMALY_DETECTED,
  timestamp: 1706457600000,
  instance: { host: 'valkey.example.com', port: 6379 },
  data: { metricType: 'latency', value: 42, baseline: 10, message: 'Latency anomaly' },
};

describe('webhook-payload-formatter', () => {
  it('passes generic payloads through unchanged', () => {
    expect(
      JSON.parse(formatWebhookBody({ payloadFormat: WebhookPayloadFormat.GENERIC }, base)),
    ).toEqual(JSON.parse(JSON.stringify(base)));
    expect(JSON.parse(formatWebhookBody({}, base))).toEqual(JSON.parse(JSON.stringify(base)));
  });

  it('renders Slack Block Kit with fields + dashboard link', () => {
    const slack = toSlack(base, 'https://betterdb.example.com');
    expect(slack['text']).toContain('Latency anomaly');
    const blocks = slack['blocks'] as unknown[];
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    const actions = blocks[blocks.length - 1] as { elements: Array<{ url: string }> };
    expect(actions.elements[0].url).toBe('https://betterdb.example.com/anomalies');
  });

  it('renders Discord embed with fields + timestamp', () => {
    const discord = toDiscord(base, 'https://betterdb.example.com') as {
      embeds: Array<{ fields: Array<{ name: string }>; url: string }>;
    };
    const names = discord.embeds[0].fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['Event', 'Instance', 'Metric', 'Value / baseline']));
    expect(discord.embeds[0].url).toBe('https://betterdb.example.com/anomalies');
  });
});

describe('webhook-payload-formatter: untrusted text', () => {
  // ACL LOG records the username an unauthenticated client *tried*, so
  // `AUTH <!channel> x` / `AUTH @everyone x` reaches client.blocked verbatim.
  const hostile: WebhookPayload = {
    ...base,
    event: WebhookEventType.CLIENT_BLOCKED,
    data: {
      username: '<!channel>',
      message:
        'Client blocked: authentication failure by <!channel> <https://evil.example|Reset your password> @everyone [Reset](https://evil.example)@10.0.0.9:51234 (count: 1)',
    },
  };

  it('neutralises Slack mentions and masked links', () => {
    const body = formatWebhookBody({ payloadFormat: WebhookPayloadFormat.SLACK }, hostile);
    expect(body).not.toContain('<!channel>');
    expect(body).not.toContain('<https://evil.example|');
    expect(body).toContain('&lt;!channel&gt;');
  });

  it('disables Discord pings and masked links', () => {
    const discord = JSON.parse(
      formatWebhookBody({ payloadFormat: WebhookPayloadFormat.DISCORD }, hostile),
    ) as {
      content: string;
      allowed_mentions: { parse: string[] };
      embeds: Array<{ title: string }>;
    };
    expect(discord.allowed_mentions).toEqual({ parse: [] });
    expect(discord.content).not.toMatch(/(^|[^\\])\[Reset\]\(https/);
    expect(discord.content).not.toContain('@everyone');
    expect(discord.embeds[0].title).toBe(discord.content);
  });

  it('leaves the generic JSON payload untouched', () => {
    expect(JSON.parse(formatWebhookBody({}, hostile))).toEqual(JSON.parse(JSON.stringify(hostile)));
  });
});
