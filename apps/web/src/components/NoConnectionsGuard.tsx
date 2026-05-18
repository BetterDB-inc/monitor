import { useConnection } from '../hooks/useConnection';
import { ReactNode, ReactElement, useState, useRef, useEffect } from 'react';
import { useIsDemo } from '../contexts/DemoContext';
import { useTelemetry } from '../hooks/useTelemetry';


function ProviderGuidesInfo() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleMouseEnter() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  }

  function handleMouseLeave() {
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
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
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
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
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

function openAddConnectionDialog() {
  window.dispatchEvent(new CustomEvent('betterdb:open-add-connection'));
}

interface NoConnectionsGuardProps {
  children: ReactNode;
}

export function NoConnectionsGuard({ children }: NoConnectionsGuardProps): ReactElement | null {
  const { hasNoConnections, loading, error } = useConnection();
  const isDemo = useIsDemo();
  const { client: telemetry } = useTelemetry();

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
    return (
      <div className="flex flex-col">
        <p className="text-[10px] font-bold tracking-[0.2em] uppercase text-primary mb-5 select-none">
          {isDemo ? 'Demo workspace' : 'No database connected'}
        </p>

        <h1 className="text-[2.6rem] font-extrabold tracking-tight leading-[1.06] mb-5 text-foreground">
          {isDemo
            ? <>Explore the<br />dashboard.</>
            : <>Connect your<br />database.</>}
        </h1>

        <p className="text-[15px] text-muted-foreground leading-relaxed mb-7">
          {isDemo
            ? "You're in a read-only demo. Select a pre-configured connection from the sidebar to explore live metrics."
            : 'Add a Valkey or Redis instance to monitor slow queries, latency, client activity, and memory - all in one place.'}
        </p>

        {!isDemo && (
          <div className="flex items-center gap-4">
            <button
              onClick={openAddConnectionDialog}
              className="inline-flex items-center gap-2 h-9 px-5 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 cursor-pointer"
            >
              <span className="text-[1.1rem] leading-none">+</span>
              Add Connection
            </button>

            <span className="inline-flex items-center gap-1.5">
              <a
                href="https://docs.betterdb.com/providers/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:underline underline-offset-4 transition-colors"
              >
                Provider setup guides
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
              <ProviderGuidesInfo />
            </span>

            {isCloudDomain && (
              <>
                <span className="text-xs text-muted-foreground">or</span>
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
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  return <>{children}</>;
}
