import { useState, useEffect, ReactNode } from 'react';

interface ServerStartupGuardProps {
  children: ReactNode;
}

interface DetailedHealthResponse {
  status: string;
  license?: {
    isValidated: boolean;
    tier: string;
  };
}

// Match the API base URL logic from api/client.ts
const API_BASE = import.meta.env.PROD ? '/api' : 'http://localhost:3001';
const MAX_RETRIES = 60; // 60 retries * 1 second = 60 seconds max wait
const RETRY_INTERVAL = 1000;

export function ServerStartupGuard({ children }: ServerStartupGuardProps) {
  const [serverReady, setServerReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let retries = 0;
    let mounted = true;
    let timeoutId: NodeJS.Timeout | null = null;

    async function checkServer() {
      try {
        const response = await fetch(`${API_BASE}/health/detailed`, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
        });

        if (response.ok && mounted) {
          const data: DetailedHealthResponse = await response.json();

          // Server is ready when license validation is complete (or no license service)
          const licenseReady = !data.license || data.license.isValidated;

          if (licenseReady) {
            setServerReady(true);
            return;
          }
          // License not yet validated, keep polling
        }
      } catch {
        // Server not ready yet
      }

      retries++;
      if (mounted) {
        // Issue #15: Show progress to user
        setRetryCount(retries);
      }

      if (retries >= MAX_RETRIES) {
        if (mounted) {
          setError('Server is taking too long to start. Please refresh the page or check server logs.');
        }
        return;
      }

      // Issue #12: Store timeout ID for cleanup to prevent memory leak
      if (mounted) {
        timeoutId = setTimeout(checkServer, RETRY_INTERVAL);
      }
    }

    checkServer();

    return () => {
      mounted = false;
      // Clean up pending timeout
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, []);

  if (error) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center max-w-md p-8">
          <div className="text-destructive text-6xl mb-6">!</div>
          <h1 className="text-2xl font-bold mb-4">Connection Error</h1>
          <p className="text-muted-foreground mb-6">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!serverReady) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-6" />
          <h1 className="text-xl font-semibold mb-2">Server Starting</h1>
          <p className="text-muted-foreground">Please wait while the server initializes...</p>
          {retryCount > 5 && (
            <p className="text-sm text-muted-foreground mt-4">
              Still starting... ({retryCount} seconds elapsed)
            </p>
          )}
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
