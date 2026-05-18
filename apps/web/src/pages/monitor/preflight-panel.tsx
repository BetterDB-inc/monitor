import { useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, Copy, ExternalLink } from 'lucide-react';
import type { PreflightResult } from '../../api/monitor';
import { Button } from '../../components/ui/button';

const PROVIDER_LABELS: Record<PreflightResult['provider']['provider'], string> = {
  'aws-elasticache': 'AWS ElastiCache',
  'gcp-memorystore': 'GCP Memorystore',
  'redis-cloud': 'Redis Cloud',
  upstash: 'Upstash',
  'self-hosted': 'Self-hosted',
  unknown: 'Unknown',
};

const PROVIDER_DOC_LINKS: Partial<Record<PreflightResult['provider']['provider'], string>> = {
  'aws-elasticache':
    'https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/RestrictedCommands.html',
  'gcp-memorystore': 'https://cloud.google.com/memorystore/docs/redis/product-constraints',
  'redis-cloud': 'https://redis.io/docs/latest/operate/rc/databases/configuration/',
  upstash: 'https://upstash.com/docs/redis/overall/rediscompatibility',
};

const MONITOR_SUPPORT_GENERIC_NOTICE =
  'Not all cloud providers allow the MONITOR command on their managed instances, and policies change over time. ' +
  "If the monitor doesn't log anything, consult the provider's documentation or contact us at info@betterdb.com.";

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
    <div className="space-y-4">
      <ProviderBanner preflight={preflight} />
      <MonitorSupportBanner preflight={preflight} />
      <AclBanner preflight={preflight} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Section title="Health gate">
          {preflight.health.allow ? (
            <Badge tone="ok">Healthy</Badge>
          ) : (
            <Badge tone="warn">
              Would skip:{' '}
              {SKIP_REASON_LABELS[preflight.health.skipReason ?? ''] ??
                preflight.health.skipReason ??
                'unknown'}
            </Badge>
          )}
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <dt>Memory</dt>
            <dd className="font-mono">
              {(preflight.health.signals.memoryPct * 100).toFixed(1)}%
            </dd>
            <dt>Recent OOM</dt>
            <dd className="font-mono">{preflight.health.signals.oomEventsRecent}</dd>
            <dt>Replication lag</dt>
            <dd className="font-mono">
              {formatBytes(preflight.health.signals.replicationLagBytes)}
            </dd>
            <dt>Failover</dt>
            <dd className="font-mono">
              {preflight.health.signals.failoverInProgress ? 'yes' : 'no'}
            </dd>
          </dl>
          <p className="mt-2 text-[11px] text-muted-foreground">
            The gate only blocks anomaly-triggered and scheduled captures. Manual sessions
            get this report as a warning.
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
    </div>
  );
}

function ProviderBanner({ preflight }: Props) {
  const provider = preflight.provider.provider;
  return (
    <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">
      Detected provider: <span className="font-medium">{PROVIDER_LABELS[provider]}</span>
    </div>
  );
}

function MonitorSupportBanner({ preflight }: Props) {
  const provider = preflight.provider.provider;
  const docsUrl = PROVIDER_DOC_LINKS[provider];
  const { status } = preflight.monitorSupport;

  if (status === 'yes') {
    return (
      <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3">
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="text-xs text-emerald-900 dark:text-emerald-100">
            MONITOR is available on this connection.
          </div>
        </div>
      </div>
    );
  }

  const tone = status === 'no' ? 'red' : 'amber';
  const heading =
    status === 'no'
      ? 'MONITOR appears unavailable on this connection'
      : 'MONITOR availability could not be confirmed';

  const wrapClass =
    tone === 'red'
      ? 'rounded-md border border-red-500/40 bg-red-500/10 p-3'
      : 'rounded-md border border-amber-500/40 bg-amber-500/10 p-3';
  const iconClass =
    tone === 'red'
      ? 'mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400'
      : 'mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400';
  const headingClass =
    tone === 'red'
      ? 'text-sm font-semibold text-red-900 dark:text-red-100'
      : 'text-sm font-semibold text-amber-900 dark:text-amber-100';
  const bodyClass =
    tone === 'red'
      ? 'text-xs text-red-900/90 dark:text-red-100/90'
      : 'text-xs text-amber-900/90 dark:text-amber-100/90';
  const linkClass =
    tone === 'red'
      ? 'inline-flex items-center gap-1 text-xs text-red-700 underline hover:text-red-900 dark:text-red-300 dark:hover:text-red-100'
      : 'inline-flex items-center gap-1 text-xs text-amber-700 underline hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100';

  return (
    <div className={wrapClass}>
      <div className="flex items-start gap-2">
        <AlertTriangle className={iconClass} />
        <div className="flex-1 space-y-2">
          <div className={headingClass}>{heading}</div>
          <p className={bodyClass}>{MONITOR_SUPPORT_GENERIC_NOTICE}</p>
          {docsUrl && (
            <a href={docsUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>
              {PROVIDER_LABELS[provider]} docs <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function AclBanner({ preflight }: Props) {
  if (preflight.acl.hasMonitor) {
    return (
      <div className="rounded-md border border-border p-3 text-xs">
        ACL: user <span className="font-mono">{preflight.acl.username}</span>{' '}
        <Badge tone="ok">+monitor granted</Badge>
        {preflight.acl.rawRules && (
          <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
            {preflight.acl.rawRules}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="flex-1 space-y-2">
          <div className="text-sm font-semibold text-amber-900 dark:text-amber-100">
            ACL is missing the +monitor permission
          </div>
          <p className="text-xs text-amber-900/90 dark:text-amber-100/90">
            User <span className="font-mono">{preflight.acl.username}</span> cannot run
            MONITOR until this snippet is applied. The capture will fail otherwise.
          </p>
          {preflight.acl.setUserSnippet && (
            <CopyableSnippet value={preflight.acl.setUserSnippet} />
          )}
          {preflight.acl.rawRules && (
            <p className="break-all font-mono text-[10px] text-amber-900/70 dark:text-amber-100/70">
              Current rules: {preflight.acl.rawRules}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function CopyableSnippet({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-1">
      <pre className="select-all whitespace-pre-wrap rounded-md bg-amber-950/10 p-2 font-mono text-[11px] text-amber-950 dark:bg-amber-100/10 dark:text-amber-100">
        {value}
      </pre>
      <Button size="sm" variant="ghost" onClick={handleCopy} className="h-7 gap-1 px-2">
        {copied ? (
          <>
            <Check className="h-3 w-3" /> Copied
          </>
        ) : (
          <>
            <Copy className="h-3 w-3" /> Copy snippet
          </>
        )}
      </Button>
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
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${styles}`}
    >
      {children}
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
