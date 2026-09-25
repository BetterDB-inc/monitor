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
