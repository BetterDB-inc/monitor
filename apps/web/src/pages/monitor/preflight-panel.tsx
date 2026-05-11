import type { PreflightResult } from '../../api/monitor';

const PROVIDER_LABELS: Record<PreflightResult['provider']['provider'], string> = {
  'aws-elasticache': 'AWS ElastiCache',
  'gcp-memorystore': 'GCP Memorystore',
  'redis-cloud': 'Redis Cloud',
  upstash: 'Upstash',
  'self-hosted': 'Self-hosted',
  unknown: 'Unknown',
};

const SKIP_REASON_LABELS: Record<string, string> = {
  memory_above_threshold: 'Memory above threshold',
  recent_oom: 'Recent OOM event',
  failover_in_progress: 'Failover in progress',
  replication_lag_elevated: 'Replication lag elevated',
};

interface Props {
  preflight: PreflightResult;
}

export function PreflightPanel({ preflight }: Props) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Section title="Provider">
        <div className="text-sm font-medium">
          {PROVIDER_LABELS[preflight.provider.provider]}
        </div>
        {preflight.provider.restrictions.length > 0 ? (
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {preflight.provider.restrictions.map((r) => (
              <li key={r}>{`• ${r}`}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">No managed-provider restrictions.</p>
        )}
      </Section>

      <Section title="ACL">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono">{preflight.acl.username}</span>
          {preflight.acl.hasMonitor ? (
            <Badge tone="ok">+monitor granted</Badge>
          ) : (
            <Badge tone="warn">+monitor missing</Badge>
          )}
        </div>
        {preflight.acl.rawRules && (
          <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
            {preflight.acl.rawRules}
          </p>
        )}
        {preflight.acl.setUserSnippet && (
          <pre className="mt-2 select-all whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-[11px]">
            {preflight.acl.setUserSnippet}
          </pre>
        )}
      </Section>

      <Section title="Health gate">
        {preflight.health.allow ? (
          <Badge tone="ok">Healthy</Badge>
        ) : (
          <Badge tone="warn">
            Would skip: {SKIP_REASON_LABELS[preflight.health.skipReason ?? ''] ?? preflight.health.skipReason ?? 'unknown'}
          </Badge>
        )}
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <dt>Memory</dt>
          <dd className="font-mono">{(preflight.health.signals.memoryPct * 100).toFixed(1)}%</dd>
          <dt>Recent OOM</dt>
          <dd className="font-mono">{preflight.health.signals.oomEventsRecent}</dd>
          <dt>Replication lag</dt>
          <dd className="font-mono">{formatBytes(preflight.health.signals.replicationLagBytes)}</dd>
          <dt>Failover</dt>
          <dd className="font-mono">{preflight.health.signals.failoverInProgress ? 'yes' : 'no'}</dd>
        </dl>
        <p className="mt-2 text-[11px] text-muted-foreground">
          The gate only blocks anomaly-triggered and scheduled captures. Manual sessions get
          this report as a warning.
        </p>
      </Section>

      <Section title="Throughput estimate">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <dt>Ops / sec</dt>
          <dd className="font-mono">{preflight.throughput.opsPerSec.toFixed(0)}</dd>
          <dt>Output</dt>
          <dd className="font-mono">{preflight.throughput.outputKbps.toFixed(1)} KB/s</dd>
          <dt>Estimated lines</dt>
          <dd className="font-mono">{preflight.throughput.estimatedLines.toLocaleString()}</dd>
          <dt>Estimated size</dt>
          <dd className="font-mono">{formatBytes(preflight.throughput.estimatedBytes)}</dd>
        </dl>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Estimate uses 120 B/line × current ops/sec × duration. Real captures vary with
          command shape.
        </p>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

function Badge({ tone, children }: { tone: 'ok' | 'warn'; children: React.ReactNode }) {
  const styles =
    tone === 'ok'
      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
      : 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${styles}`}>
      {children}
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
