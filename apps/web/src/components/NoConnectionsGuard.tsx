import { useConnection } from '../hooks/useConnection';
import { ReactNode, ReactElement, useState, useRef, useEffect, FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useIsDemo } from '../contexts/DemoContext';
import { useTelemetry } from '../hooks/useTelemetry';
import { fetchApi } from '../api/client';
import { parseConnectionUrl, ParsedConnection } from '../utils/connectionUrl';

interface PageEmptyState {
  headline: string;
  description: string;
}

const DEFAULT_PAGE_STATE: PageEmptyState = {
  headline: 'Connect your database.',
  description:
    'Add a Valkey or Redis instance to monitor slow queries, latency, client activity, and memory - all in one place.',
};

const PAGE_STATES: Record<string, PageEmptyState> = {
  '/slowlog': {
    headline: 'Find your slowest queries.',
    description:
      'Once a database is connected, Slow Log surfaces the commands slowing it down - grouped into patterns, with full history.',
  },
  '/latency': {
    headline: 'Track latency in real time.',
    description:
      'Connect a database to see latency spikes, per-event history, and intrinsic latency for your Valkey or Redis instance.',
  },
  '/clients': {
    headline: 'See who’s connected.',
    description:
      'Connect a database to inspect every client connection - buffers, idle time, and the commands each one runs.',
  },
  '/client-analytics': {
    headline: 'Understand your clients.',
    description:
      'Connect a database to see aggregated client activity: top consumers, connection churn, and command mix over time.',
  },
  '/client-analytics/deep-dive': {
    headline: 'Go deep on client behavior.',
    description:
      'Connect a database to drill into per-client command patterns, traffic distribution, and behavior over time.',
  },
  '/cluster': {
    headline: 'Monitor your whole cluster.',
    description:
      'Connect a cluster node to see node health, slot coverage, and per-node stats in one view.',
  },
  '/forecasting': {
    headline: 'See problems before they happen.',
    description:
      'Connect a database to get memory and key-count forecasts built from its real usage trends.',
  },
  '/anomalies': {
    headline: 'Catch anomalies automatically.',
    description:
      'Connect a database and BetterDB will flag data loss, latency spikes, and memory anomalies from live metrics.',
  },
  '/key-analytics': {
    headline: 'Know what’s in your keyspace.',
    description:
      'Connect a database to explore key patterns, sizes, TTL distribution, and the keys eating your memory.',
  },
  '/bulk-delete': {
    headline: 'Clean up your keyspace safely.',
    description:
      'Connect a database to preview and delete keys by pattern - with dry runs and guardrails before anything is removed.',
  },
  '/vector-search': {
    headline: 'Inspect your vector indexes.',
    description:
      'Connect a database with vector search to browse indexes, dimensions, and query performance.',
  },
  '/vector-ai': {
    headline: 'Vector & AI workloads at a glance.',
    description:
      'Connect a database to monitor embeddings, similarity queries, and AI workload health.',
  },
  '/ai-cache-memory': {
    headline: 'Watch your AI cache work.',
    description:
      'Connect the Valkey instance behind your semantic cache and agent memory to see hit rates, savings, and memory usage live.',
  },
  '/ai-traces': {
    headline: 'Trace your AI agents.',
    description:
      'Connect a database to correlate OpenTelemetry traces with Valkey calls - every LLM call, cache hit, and memory lookup in a waterfall.',
  },
  '/inference-latency': {
    headline: 'Measure inference latency.',
    description:
      'Connect a database to track end-to-end inference timings across your AI pipeline.',
  },
  '/audit': {
    headline: 'Audit every ACL event.',
    description:
      'Connect a database to capture authentication failures and permission denials from ACL LOG.',
  },
  '/monitor': {
    headline: 'Watch commands live.',
    description:
      'Connect a database to stream every command in real time, with filtering and recorded sessions.',
  },
  '/webhooks': {
    headline: 'Get alerted where you work.',
    description:
      'Connect a database first - then webhooks can fire on anomalies, thresholds, and health changes.',
  },
  '/migration': {
    headline: 'Migrate with confidence.',
    description:
      'Connect a source database to analyze its dataset and migrate to Valkey with verification at every step.',
  },
  '/cache-proposals': {
    headline: 'Let BetterDB tune your cache.',
    description:
      'Connect the Valkey instance behind your semantic cache to review AI-generated tuning proposals you approve or reject.',
  },
  '/helper': {
    headline: 'Ask your database anything.',
    description:
      'Connect a database to ask questions about its health, memory, and workload in plain English.',
  },
};

const PROVIDERS: { name: string; slug: string }[] = [
  { name: 'Upstash', slug: 'upstash' },
  { name: 'Redis Cloud', slug: 'redis-cloud' },
  { name: 'AWS ElastiCache', slug: 'aws-elasticache' },
  { name: 'AWS MemoryDB', slug: 'aws-memorydb' },
];

const DOCKER_COMMAND = 'docker run -d -p 6379:6379 valkey/valkey';

function ProviderGuidesInfo() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handlePointerEnter(e: React.PointerEvent) {
    if (e.pointerType !== 'mouse') return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  }

  function handlePointerLeave(e: React.PointerEvent) {
    if (e.pointerType !== 'mouse') return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 500);
  }

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div
      className="relative"
      ref={ref}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer"
        aria-label="More information about provider guides"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="6.25" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 6.5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="7" cy="4" r="0.75" fill="currentColor" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-64 rounded-lg border border-border bg-popover text-popover-foreground shadow-md p-3 text-[12px] leading-relaxed z-50"
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
        >
          <p className="text-muted-foreground">
            More guides coming soon. If you have issues with a specific provider,{' '}
            <a
              href="mailto:info@betterdb.com"
              className="font-medium text-foreground underline underline-offset-2 hover:text-primary transition-colors"
            >
              email us
            </a>
            {' '}or{' '}
            <a
              href="https://github.com/BetterDB-inc/monitor/issues/new"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground underline underline-offset-2 hover:text-primary transition-colors"
            >
              open a GitHub issue
            </a>
            {' '}and we'll help.
          </p>
        </div>
      )}
    </div>
  );
}

interface OpenAddConnectionOptions {
  prefill?: Partial<ParsedConnection>;
  tab?: 'direct' | 'agent' | 'valkey';
  valkeyMaxmemory?: string;
}

function openAddConnectionDialog(options?: OpenAddConnectionOptions) {
  window.dispatchEvent(
    new CustomEvent('betterdb:open-add-connection', options ? { detail: options } : undefined)
  );
}

function isLocalhostHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '::1' || h === '0.0.0.0' || /^127\./.test(h);
}

interface QuickConnectProps {
  isCloudDomain: boolean;
  onConnected: () => Promise<void>;
  capture: (event: string, props?: Record<string, unknown>) => void;
}

function QuickConnect({ isCloudDomain, onConnected, capture }: QuickConnectProps) {
  const [url, setUrl] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedConnection | null>(null);

  async function saveConnection(connection: ParsedConnection) {
    setConnecting(true);
    setError(null);
    try {
      await fetchApi<{ id: string }>('/connections', {
        method: 'POST',
        body: JSON.stringify({
          name: connection.name,
          host: connection.host,
          port: connection.port,
          username: connection.username || undefined,
          password: connection.password || undefined,
          dbIndex: connection.dbIndex,
          tls: connection.tls,
          setAsDefault: true,
        }),
      });
      capture('quick_connect_succeeded', { source: 'empty_state' });
      await onConnected();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      capture('quick_connect_failed', { source: 'empty_state' });
      setError(message);
      setParsed(connection);
    } finally {
      setConnecting(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setParsed(null);
    const result = parseConnectionUrl(url);
    if (!result.ok) {
      setError(result.error);
      capture('quick_connect_failed', { source: 'empty_state', reason: 'parse' });
      return;
    }
    if (isCloudDomain && isLocalhostHost(result.value.host)) {
      setError('localhost is not reachable from the cloud. Please provide a publicly accessible host.');
      return;
    }
    await saveConnection(result.value);
  }

  return (
    <div data-testid="quick-connect">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-2.5">
        <label htmlFor="quick-connect-url" className="text-sm font-semibold text-foreground">
          Quick connect
        </label>
        <span className="text-xs text-muted-foreground">
          paste a connection URL · ~30 seconds
        </span>
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2.5">
        <input
          id="quick-connect-url"
          type="text"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
            setParsed(null);
          }}
          placeholder="rediss://default:password@your-host:6379"
          autoComplete="off"
          spellCheck={false}
          className="h-11 flex-1 min-w-0 px-3.5 text-sm font-mono border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent placeholder:font-mono placeholder:text-muted-foreground/50 transition-shadow"
        />
        <button
          type="submit"
          disabled={connecting || !url.trim()}
          className="h-11 px-6 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 cursor-pointer flex-shrink-0"
        >
          {connecting ? 'Connecting…' : 'Connect'}
        </button>
      </form>
      {error && (
        <div className="mt-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3.5 py-2.5 text-left">
          <p>{error}</p>
          {parsed && (
            <button
              type="button"
              onClick={() => openAddConnectionDialog({ prefill: parsed })}
              className="mt-1 font-medium underline underline-offset-2 hover:no-underline cursor-pointer"
            >
              Review details in the full form →
            </button>
          )}
        </div>
      )}
      <p className="mt-3.5 flex items-start justify-center gap-1.5 text-xs text-muted-foreground">
        <svg
          width="12"
          height="12"
          viewBox="0 0 14 14"
          fill="none"
          aria-hidden="true"
          className="flex-shrink-0 mt-[2px]"
        >
          <rect x="2.5" y="6" width="9" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        Monitoring runs read-only commands like INFO, SLOWLOG, and CLIENT LIST - your data is never modified unless you explicitly enable it as an option and do it through the CLI at the bottom.
      </p>
    </div>
  );
}

function DockerQuickStart({
  onConnected,
  capture,
}: {
  onConnected: () => Promise<void>;
  capture: (event: string, props?: Record<string, unknown>) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(DOCKER_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (non-secure context); ignore.
    }
  }

  async function handleConnectLocalhost() {
    setConnecting(true);
    setError(null);
    try {
      await fetchApi<{ id: string }>('/connections', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Local Valkey',
          host: 'localhost',
          port: 6379,
          dbIndex: 0,
          tls: false,
          setAsDefault: true,
        }),
      });
      capture('quick_connect_succeeded', { source: 'empty_state_localhost' });
      await onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach localhost:6379');
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card/60 p-5 text-left">
      <p className="text-sm font-semibold mb-1">Running Valkey or Redis locally?</p>
      <p className="text-xs text-muted-foreground mb-3">
        Connect to the default local instance in one click:
      </p>
      <button
        type="button"
        onClick={handleConnectLocalhost}
        disabled={connecting}
        className="w-full h-10 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 cursor-pointer"
      >
        {connecting ? 'Connecting…' : 'Connect localhost:6379 →'}
      </button>
      {error && (
        <p className="mt-2.5 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
          {error}
        </p>
      )}
      <p className="mt-4 mb-2 text-xs text-muted-foreground">
        No database yet? Start one with Docker:
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 overflow-x-auto whitespace-nowrap px-3 py-2 text-[11px] font-mono rounded-md bg-muted text-foreground/90">
          {DOCKER_COMMAND}
        </code>
        <button
          type="button"
          onClick={handleCopy}
          className="h-8 px-3 text-xs font-medium border border-border rounded-md hover:bg-muted transition-colors cursor-pointer flex-shrink-0"
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function CloudProvisionCard({
  capture,
}: {
  capture: (event: string, props?: Record<string, unknown>) => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-5 text-left">
      <p className="text-sm font-semibold mb-1">No database yet?</p>
      <p className="text-xs text-muted-foreground mb-3">
        Provision a managed 1 GB Valkey instance in your workspace - ready in about a minute:
      </p>
      <button
        type="button"
        onClick={() => {
          capture('provision_instance_clicked', { source: 'empty_state' });
          openAddConnectionDialog({ tab: 'valkey', valkeyMaxmemory: '1gb' });
        }}
        className="w-full h-10 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 cursor-pointer"
      >
        Create a 1 GB Valkey instance →
      </button>
      <p className="mt-3 text-xs text-muted-foreground">
        Runs on BetterDB Cloud and connects to your workspace automatically.
      </p>
    </div>
  );
}

function ProvidersCard({
  capture,
}: {
  capture: (event: string, props?: Record<string, unknown>) => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-5 text-left">
      <p className="text-sm font-semibold mb-1">Using a managed provider?</p>
      <p className="text-xs text-muted-foreground mb-3">
        Step-by-step guides for finding your connection details:
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {PROVIDERS.map((provider) => (
          <a
            key={provider.slug}
            href={`https://docs.betterdb.com/providers/${provider.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => capture('provider_guide_clicked', { provider: provider.slug })}
            className="inline-flex items-center h-7 px-3 rounded-full border border-border bg-background/50 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
          >
            {provider.name}
          </a>
        ))}
        <span className="inline-flex items-center gap-1.5 ml-1">
          <a
            href="https://docs.betterdb.com/providers/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline underline-offset-4 transition-colors"
          >
            All guides
            <svg width="12" height="12" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <path
                d="M2 6.5h9M7.5 3l3.5 3.5L7.5 10"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </a>
          <ProviderGuidesInfo />
        </span>
      </div>
    </div>
  );
}

interface NoConnectionsGuardProps {
  children: ReactNode;
}

export function NoConnectionsGuard({ children }: NoConnectionsGuardProps): ReactElement | null {
  const { hasNoConnections, loading, error, refreshConnections } = useConnection();
  const isDemo = useIsDemo();
  const { client: telemetry } = useTelemetry();
  const location = useLocation();

  const isCloudDomain =
    typeof window !== 'undefined' &&
    window.location.hostname.endsWith('.app.betterdb.com');

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading connections...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] p-8">
        <div className="max-w-md">
          <h2 className="text-2xl font-bold mb-4 text-destructive">Connection Error</h2>
          <p className="text-muted-foreground mb-6">
            Failed to load database connections. Please check your configuration and try again.
          </p>
          <p className="text-sm text-muted-foreground font-mono bg-muted p-3 rounded">
            {error}
          </p>
        </div>
      </div>
    );
  }

  if (hasNoConnections) {
    const page = PAGE_STATES[location.pathname] ?? DEFAULT_PAGE_STATE;
    const capture = (event: string, props?: Record<string, unknown>) =>
      telemetry.capture(event, { page: location.pathname, ...props });

    if (isDemo) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="max-w-md text-center">
            <p className="text-[10px] font-bold tracking-[0.2em] uppercase text-primary mb-4 select-none">
              Demo workspace
            </p>
            <h1 className="text-3xl font-extrabold tracking-tight mb-3 text-foreground">
              Explore the dashboard.
            </h1>
            <p className="text-[15px] text-muted-foreground leading-relaxed">
              You're in a read-only demo. Select a pre-configured connection from the sidebar to
              explore live metrics.
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="relative flex-1 flex items-center justify-center">
        {/* Background accent */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute left-1/2 top-[42%] h-[460px] w-[880px] max-w-full -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/[0.07] blur-3xl" />
        </div>

        <div className="relative w-full max-w-[52rem] mx-auto py-10 text-center">
          <p className="text-[10px] font-bold tracking-[0.2em] uppercase text-primary mb-4 select-none">
            No database connected
          </p>

          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight leading-tight mb-3 text-foreground text-balance">
            {page.headline}
          </h1>

          <p className="text-[15px] text-muted-foreground leading-relaxed mb-8">
            {page.description}
          </p>

          {/* Hero card */}
          <div className="rounded-2xl border border-border bg-card shadow-2xl shadow-black/10 overflow-hidden">
            <div className="h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent" />
            <div className="p-6 sm:p-8">
              <QuickConnect
                isCloudDomain={isCloudDomain}
                onConnected={refreshConnections}
                capture={capture}
              />
            </div>

            <div className="flex items-center gap-3 px-6 sm:px-8" aria-hidden="true">
              <div className="h-px flex-1 bg-border" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                or
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <div className="p-5 sm:px-8 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
              <button
                onClick={() => openAddConnectionDialog()}
                className="inline-flex items-center gap-2 h-10 px-5 rounded-lg border border-border text-sm font-semibold text-foreground hover:border-primary/50 hover:bg-primary/5 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 cursor-pointer"
              >
                <span className="text-[1.05rem] leading-none text-primary">+</span>
                Add connection manually
              </button>

              {isCloudDomain && (
                <a
                  href="https://demo.app.betterdb.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => telemetry.capture('demo_link_clicked', { source: 'empty_state' })}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline underline-offset-4 transition-colors"
                >
                  Try the live demo first
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                    <path
                      d="M2 6.5h9M7.5 3l3.5 3.5L7.5 10"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </a>
              )}
            </div>
          </div>

          {/* Supporting options */}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <ProvidersCard capture={capture} />
            {isCloudDomain ? (
              <CloudProvisionCard capture={capture} />
            ) : (
              <DockerQuickStart onConnected={refreshConnections} capture={capture} />
            )}
          </div>

          <p className="mt-6 text-xs text-muted-foreground">
            Having trouble connecting?{' '}
            <a
              href="https://docs.betterdb.com/troubleshooting.html#connection-issues"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium underline underline-offset-4 hover:text-foreground transition-colors"
            >
              Read the connection troubleshooting guide →
            </a>
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
