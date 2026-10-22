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
        '          metric_relabel_configs:',
        '            - source_labels: [__name__]',
        "              regex: 'lmcache:.*'",
        '              action: keep',
        'processors:',
        '  resource:',
        '    attributes:',
        '      - key: betterdb.lmcache.engine',
        "        value: 'lmc-abc123'",
        '        action: upsert',
        'exporters:',
        '  otlphttp:',
        '    metrics_endpoint: https://betterdb.example.com/v1/external/metrics',
        '    # Remove this headers block if BetterDB Monitor has no OTEL_INGEST_TOKEN set.',
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

  it('tells the user to drop the headers block when Monitor has no ingest token', () => {
    const lines = collectorSnippet('lmc-1', 'http://x').split('\n');
    const headers = lines.indexOf('    headers:');
    expect(lines[headers - 1]).toMatch(/^\s*# Remove this headers block .*OTEL_INGEST_TOKEN/);
  });

  it.each(['0123', '1e3', '1.50', 'null', 'true'])(
    'quotes engine id %s so YAML keeps it a string',
    (id) => {
      expect(collectorSnippet(id, 'http://x').split('\n')).toContain(`        value: '${id}'`);
    },
  );

  it('honours a custom scrape target', () => {
    expect(collectorSnippet('lmc-1', 'http://x', 'lmcache-host:9090')).toContain(
      "- targets: ['lmcache-host:9090']",
    );
  });
});
