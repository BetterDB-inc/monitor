import { useState } from 'react';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { RefreshCw } from 'lucide-react';

interface Props {
  featureName: string;
  command: string;
  children: React.ReactNode;
  /**
   * Optional override for the descriptive sentence. Defaults to the
   * managed-service ACL-blocked wording which fits commands like
   * CLIENT LIST, SLOWLOG, LATENCY. Use a custom description for
   * features gated on module availability (e.g. RediSearch / valkey-search).
   */
  description?: React.ReactNode;
  /**
   * Verbatim error string returned by the server (e.g. "ERR Command is not
   * available: 'SLOWLOG'"). Surfaced so operators can see exactly why the
   * command was disabled.
   */
  reason?: string;
  /**
   * If provided, a Retry button is shown that calls this handler. Use to
   * re-enable a runtime capability after the operator has unblocked the
   * command on the database side.
   */
  onRetry?: () => Promise<void> | void;
}

export function UnavailableOverlay({
  featureName,
  command,
  children,
  description,
  reason,
  onRetry,
}: Props) {
  const [retrying, setRetrying] = useState(false);

  const defaultDescription = (
    <>
      The <code className="px-1 py-0.5 bg-muted rounded text-xs">{command}</code> command is
      blocked by this database instance. This is common with managed services (e.g. AWS
      ElastiCache Serverless, Upstash) that restrict certain commands.
    </>
  );

  const handleRetry = async () => {
    if (!onRetry) {
      return;
    }
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="relative">
      <div className="opacity-40 pointer-events-none">{children}</div>
      <div className="absolute inset-0 flex items-center justify-center">
        <Card className="max-w-md shadow-lg">
          <CardContent className="pt-6 text-center space-y-3">
            <p className="text-lg font-semibold">{featureName} Unavailable</p>
            <p className="text-sm text-muted-foreground">
              {description ?? defaultDescription}
            </p>
            {reason && (
              <p className="text-xs font-mono bg-muted rounded px-2 py-1 text-left break-words">
                {reason}
              </p>
            )}
            {onRetry && (
              <div className="pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleRetry}
                  disabled={retrying}
                >
                  <RefreshCw className={retrying ? 'animate-spin' : ''} />
                  {retrying ? 'Retrying…' : 'Retry now'}
                </Button>
                <p className="text-xs text-muted-foreground mt-2">
                  Use this if you&apos;ve enabled the command on the database side and want
                  to verify it without waiting for the next poll cycle.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
