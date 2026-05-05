import { useConnection } from '../hooks/useConnection';
import { ReactNode, ReactElement } from 'react';
import { useIsDemo } from '../contexts/DemoContext';
import { useTelemetry } from '../hooks/useTelemetry';


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
              className="inline-flex items-center gap-2 h-9 px-5 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <span className="text-[1.1rem] leading-none">+</span>
              Add Connection
            </button>

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
