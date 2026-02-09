import { useConnection } from '../hooks/useConnection';
import { ReactNode, ReactElement } from 'react';

interface NoConnectionsGuardProps {
  children: ReactNode;
}

export function NoConnectionsGuard({ children }: NoConnectionsGuardProps): ReactElement | null {
  const { hasNoConnections, loading, error } = useConnection();

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
        <div className="text-center max-w-md">
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
      <div className="flex items-center min-h-[60vh] p-8">
        {/* Arrow pointing to sidebar */}
        <div className="flex items-center gap-4 -ml-4">
          <svg
            className="w-12 h-12 text-primary animate-pulse"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-label="Arrow pointing left"
            role="img"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
          <div className="text-left">
            <h2 className="text-2xl font-bold mb-2">No Database Connected</h2>
            <p className="text-muted-foreground">
              Use the <span className="font-medium text-foreground">Connection</span> selector
              in the sidebar to add your first database connection.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
