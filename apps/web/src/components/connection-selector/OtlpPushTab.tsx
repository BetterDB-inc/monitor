import { useState } from 'react';
import { apiOrigin, fetchApi } from '../../api/client';

export function buildCollectorSnippet(host: string, port: number, origin: string): string {
  return `receivers:
  redis:
    endpoint: ${host}:${port}
    collection_interval: 15s
    resource_attributes:
      server.address:
        enabled: true
      server.port:
        enabled: true
    metrics:
      redis.maxmemory:
        enabled: true
      redis.role:
        enabled: true
      redis.cmd.calls:
        enabled: true
      redis.cmd.usec:
        enabled: true

exporters:
  otlphttp/betterdb:
    metrics_endpoint: ${origin}/v1/external/metrics
    headers:
      Authorization: "Bearer \${env:BETTERDB_OTEL_INGEST_TOKEN}"

service:
  pipelines:
    metrics:
      receivers: [redis]
      exporters: [otlphttp/betterdb]
`;
}

export function OtlpPushTab({
  isFirstConnection,
  onCreated,
  onDone,
}: {
  isFirstConnection: boolean;
  onCreated: () => Promise<void>;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(6379);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const snippet = buildCollectorSnippet(host || '<host>', port, apiOrigin());
  const canSave =
    name.trim() !== '' &&
    host.trim() !== '' &&
    Number.isInteger(port) &&
    port > 0 &&
    port <= 65535 &&
    !saving;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await fetchApi<{ id: string }>('/connections', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          host: host.trim(),
          port,
          connectionType: 'external',
          setAsDefault: isFirstConnection,
        }),
      });
      await onCreated();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save connection');
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const collectorConfig = (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium">Collector config</span>
        <button type="button" onClick={copy} className="text-xs text-primary hover:underline">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs dark:[color-scheme:dark]">{snippet}</pre>
      <p className="mt-1 text-xs text-muted-foreground">
        Set <code>BETTERDB_OTEL_INGEST_TOKEN</code> to this server's{' '}
        <code>OTEL_INGEST_TOKEN</code>. Use <code>metrics_endpoint</code>, not{' '}
        <code>endpoint</code>: <code>endpoint</code> appends /v1/metrics.
      </p>
    </div>
  );

  if (saved) {
    return (
      <div className="min-w-0 space-y-4">
        <p className="text-sm text-green-600">
          Connection added. Copy the collector config below before closing this dialog.
        </p>
        {collectorConfig}
        <button
          type="button"
          onClick={onDone}
          className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      <p className="text-sm text-muted-foreground">
        BetterDB won't connect to this instance. An OpenTelemetry Collector scrapes it and pushes
        metrics here. Views that need a live connection (slow log, clients, key analytics) stay
        unavailable.
      </p>
      <div>
        <label htmlFor="otlp-name" className="block text-sm font-medium mb-1">
          Name *
        </label>
        <input
          id="otlp-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Production cache"
          className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label htmlFor="otlp-host" className="block text-sm font-medium mb-1">
            Host *
          </label>
          <input
            id="otlp-host"
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="cache.internal"
            className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <div>
          <label htmlFor="otlp-port" className="block text-sm font-medium mb-1">
            Port *
          </label>
          <input
            id="otlp-port"
            type="number"
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
            className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Host and port must match the collector's <code>server.address</code> and{' '}
        <code>server.port</code> resource attributes.
      </p>
      {collectorConfig}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <button
        type="button"
        onClick={save}
        disabled={!canSave}
        className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
      >
        {saving ? 'Adding…' : 'Add OTLP connection'}
      </button>
    </div>
  );
}
