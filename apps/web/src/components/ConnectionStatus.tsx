import { useHealth } from '../hooks/useHealth';

function ConnectionStatus() {
  const { health, loading, error } = useHealth();

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow-lg p-8 max-w-2xl w-full">
        <div className="text-center text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg shadow-lg p-8 max-w-2xl w-full">
        <div className="text-center">
          <div className="text-destructive text-lg font-semibold mb-2">Connection Error</div>
          <div className="text-muted-foreground text-sm">{error}</div>
        </div>
      </div>
    );
  }

  if (!health) {
    return null;
  }

  const statusColor =
    health.status === 'connected'
      ? 'text-green-600'
      : health.status === 'disconnected'
        ? 'text-destructive'
        : 'text-orange-600';

  const statusBgColor =
    health.status === 'connected'
      ? 'bg-green-100'
      : health.status === 'disconnected'
        ? 'bg-destructive/10'
        : 'bg-orange-100';

  return (
    <div className="bg-white rounded-lg shadow-lg p-8 max-w-2xl w-full">
      <div className="text-center mb-6">
        <h1 className="text-3xl font-bold text-foreground mb-4">BetterDB Monitor</h1>
        <div className="flex items-center justify-center gap-2">
          <span className={`px-4 py-2 rounded-md ${statusBgColor} ${statusColor} font-semibold capitalize`}>
            {health.status}
          </span>
        </div>
      </div>

      <div className="border-t border-border pt-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Database Information</h2>

        <div className="space-y-3">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Type:</span>
            <span className="font-medium capitalize">{health.database.type}</span>
          </div>

          <div className="flex justify-between">
            <span className="text-muted-foreground">Version:</span>
            <span className="font-medium">
              {health.database.version || 'N/A'}
            </span>
          </div>

          <div className="flex justify-between">
            <span className="text-muted-foreground">Host:</span>
            <span className="font-medium">{health.database.host}</span>
          </div>

          <div className="flex justify-between">
            <span className="text-muted-foreground">Port:</span>
            <span className="font-medium">{health.database.port}</span>
          </div>
        </div>
      </div>

      {health.capabilities && (
        <div className="border-t border-border pt-6 mt-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">Capabilities</h2>

          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Command Log:</span>
              <span
                className={`font-medium ${health.capabilities.hasCommandLog ? 'text-green-600' : 'text-muted-foreground'}`}
              >
                {health.capabilities.hasCommandLog ? 'Available' : 'Not Available'}
              </span>
            </div>

            <div className="flex justify-between">
              <span className="text-muted-foreground">Slot Stats:</span>
              <span
                className={`font-medium ${health.capabilities.hasSlotStats ? 'text-green-600' : 'text-muted-foreground'}`}
              >
                {health.capabilities.hasSlotStats ? 'Available' : 'Not Available'}
              </span>
            </div>
          </div>
        </div>
      )}

      {health.error && (
        <div className="border-t border-border pt-6 mt-6">
          <div className="bg-destructive/5 border border-destructive/20 rounded-md p-4">
            <div className="text-destructive text-sm font-medium">Error</div>
            <div className="text-destructive text-sm mt-1">{health.error}</div>
          </div>
        </div>
      )}

      <div className="border-t border-border pt-4 mt-6">
        <div className="text-xs text-muted-foreground text-center">Auto-refreshes every 5 seconds</div>
      </div>
    </div>
  );
}

export default ConnectionStatus;
