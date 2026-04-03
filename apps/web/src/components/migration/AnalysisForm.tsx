import { useState } from 'react';
import { useConnection } from '../../hooks/useConnection';
import type { Connection } from '../../hooks/useConnection';
import { fetchApi } from '../../api/client';
import type { StartAnalysisResponse } from '@betterdb/shared';

interface Props {
  onStart: (analysisId: string) => void;
}

function connectionLabel(c: Connection): string {
  const base = `${c.name} (${c.host}:${c.port})`;
  if (c.capabilities?.dbType && c.capabilities?.version) {
    const type = c.capabilities.dbType === 'valkey' ? 'Valkey' : 'Redis';
    return `${base} — ${type} ${c.capabilities.version}`;
  }
  return base;
}

export function AnalysisForm({ onStart }: Props) {
  const { connections, currentConnection } = useConnection();
  const [sourceConnectionId, setSourceConnectionId] = useState(currentConnection?.id ?? '');
  const [targetConnectionId, setTargetConnectionId] = useState('');
  const [scanSampleSize, setScanSampleSize] = useState(10000);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sameConnection =
    sourceConnectionId !== '' &&
    targetConnectionId !== '' &&
    sourceConnectionId === targetConnectionId;

  const targetConnection = connections.find(c => c.id === targetConnectionId);
  const targetIsOffline = targetConnectionId !== '' && targetConnection && !targetConnection.isConnected;

  // The API returns connectionType on each connection but the Connection
  // interface in useConnection doesn't surface it. Cast to access at runtime.
  const isAgentConnection = (id: string): boolean => {
    if (!id) return false;
    const conn = connections.find(c => c.id === id) as
      | (typeof connections[number] & { connectionType?: 'direct' | 'agent' })
      | undefined;
    return conn?.connectionType === 'agent';
  };
  const hasAgentConnection =
    isAgentConnection(sourceConnectionId) || isAgentConnection(targetConnectionId);

  const isCloudMode = import.meta.env.VITE_CLOUD_MODE === 'true';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceConnectionId || !targetConnectionId || sameConnection) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchApi<StartAnalysisResponse>('/migration/analysis', {
        method: 'POST',
        body: JSON.stringify({ sourceConnectionId, targetConnectionId, scanSampleSize }),
      });
      onStart(res.id);
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Failed to start analysis';
      if (/writeable|enableOfflineQueue|offline/i.test(raw)) {
        setError(`Could not connect to ${targetConnection?.name ?? 'target'} — the instance appears to be offline. Check the connection before running analysis.`);
      } else {
        setError(raw);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-card border rounded-lg p-6 space-y-4 max-w-lg">
      <div>
        <label className="block text-sm font-medium mb-1">Source (migrating from)</label>
        <select
          value={sourceConnectionId}
          onChange={e => setSourceConnectionId(e.target.value)}
          className="w-full border rounded-md px-3 py-2 text-sm bg-background"
          required
        >
          <option value="">Select a connection...</option>
          {connections.map(c => (
            <option key={c.id} value={c.id}>
              {connectionLabel(c)}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Target (migrating to)</label>
        <select
          value={targetConnectionId}
          onChange={e => setTargetConnectionId(e.target.value)}
          className={`w-full border rounded-md px-3 py-2 text-sm bg-background${sameConnection ? ' border-destructive' : ''}`}
          required
        >
          <option value="">Select a connection...</option>
          {connections.map(c => (
            <option
              key={c.id}
              value={c.id}
              disabled={!c.isConnected}
              title={!c.isConnected ? 'This instance is offline' : undefined}
            >
              {!c.isConnected ? `\u25CB ${connectionLabel(c)} (offline)` : connectionLabel(c)}
            </option>
          ))}
        </select>
        {sameConnection && (
          <p className="text-sm text-destructive mt-1">
            Source and target must be different connections
          </p>
        )}
        {targetIsOffline && !sameConnection && (
          <p className="text-sm text-amber-600 mt-1">
            This instance appears to be offline and may not accept connections.
          </p>
        )}
      </div>

      {hasAgentConnection && (
        <p className="text-sm text-amber-600">
          One or more selected instances is connected via agent. Contact us at{' '}
          <a href="mailto:support@betterdb.com" className="underline">support@betterdb.com</a> to
          plan your migration — we'll help you do it safely.
        </p>
      )}

      {isCloudMode && (
        <p className="text-sm text-amber-600">
          Migration execution is not available in BetterDB Cloud. Contact us at{' '}
          <a href="mailto:support@betterdb.com" className="underline">support@betterdb.com</a> to
          plan your migration.
        </p>
      )}

      <div>
        <label className="block text-sm font-medium mb-1">Sample size</label>
        <select
          value={scanSampleSize}
          onChange={e => setScanSampleSize(Number(e.target.value))}
          className="w-full border rounded-md px-3 py-2 text-sm bg-background"
        >
          <option value={1000}>1,000 keys</option>
          <option value={5000}>5,000 keys</option>
          <option value={10000}>10,000 keys</option>
          <option value={25000}>25,000 keys</option>
        </select>
        <p className="text-xs text-muted-foreground mt-1">
          Higher sample = more accurate estimates, slower analysis.
        </p>
      </div>

      {error && (
        <div className="bg-destructive/10 border border-destructive/20 text-destructive rounded-lg p-3 text-sm">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading || !sourceConnectionId || !targetConnectionId || sameConnection || hasAgentConnection}
        className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
      >
        {loading && (
          <span className="h-3 w-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
        )}
        {loading ? 'Starting...' : 'Start Analysis'}
      </button>
    </form>
  );
}
