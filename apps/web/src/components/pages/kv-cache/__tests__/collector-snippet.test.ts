import { describe, it, expect } from 'vitest';
import { collectorSnippet } from '../collector-snippet';

describe('collectorSnippet', () => {
  it('renders the full collector config for the default scrape target', () => {
    expect(collectorSnippet('lmc-abc123', 'https://betterdb.example.com')).toBe(
      [
        'receivers:',
        '  prometheus:',
        '    config:',
        '      scrape_configs:',
        '        - job_name: lmcache',
        '          scrape_interval: 30s',
        '          static_configs:',
        "            - targets: ['vllm:8000']",
        'processors:',
        '  resource:',
        '    attributes:',
        '      - key: betterdb.lmcache.engine',
        '        value: lmc-abc123',
        '        action: upsert',
        'exporters:',
        '  otlphttp:',
        '    metrics_endpoint: https://betterdb.example.com/v1/external/metrics',
        '    headers:',
        "      Authorization: 'Bearer ${env:BETTERDB_OTEL_INGEST_TOKEN}'",
        'service:',
        '  pipelines:',
        '    metrics:',
        '      receivers: [prometheus]',
        '      processors: [resource]',
        '      exporters: [otlphttp]',
        '',
      ].join('\n'),
    );
  });

  it('honours a custom scrape target', () => {
    expect(collectorSnippet('lmc-1', 'http://x', 'lmcache-host:9090')).toContain(
      "- targets: ['lmcache-host:9090']",
    );
  });
});
