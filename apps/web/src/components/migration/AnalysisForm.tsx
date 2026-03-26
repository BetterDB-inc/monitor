import { useState } from 'react';
import { useConnection } from '../../hooks/useConnection';
import { fetchApi } from '../../api/client';
import type { StartAnalysisResponse } from '@betterdb/shared';

interface Props {
  onStart: (analysisId: string) => void;
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
      setError(err instanceof Error ? err.message : 'Failed to start analysis');
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
              {c.name} ({c.host}:{c.port})
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Target (migrating to)</label>
        <select
          value={targetConnectionId}
          onChange={e => setTargetConnectionId(e.target.value)}
          className="w-full border rounded-md px-3 py-2 text-sm bg-background"
          required
        >
          <option value="">Select a connection...</option>
          {connections.map(c => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.host}:{c.port})
            </option>
          ))}
        </select>
        {sameConnection && (
          <p className="text-sm text-red-600 mt-1">
            Source and target must be different connections
          </p>
        )}
      </div>

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

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={loading || !sourceConnectionId || !targetConnectionId || sameConnection}
        className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium disabled:opacity-50"
      >
        {loading ? 'Starting...' : 'Start Analysis'}
      </button>
    </form>
  );
}
