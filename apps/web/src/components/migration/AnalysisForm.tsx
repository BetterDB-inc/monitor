import { useState } from 'react';
import { useConnection } from '../../hooks/useConnection';
import type { Connection } from '../../hooks/useConnection';
import { useMigrationPlan } from '../../hooks/useMigrationPlan';
import { fetchApi } from '../../api/client';
import type { StartAnalysisResponse } from '@betterdb/shared';
import { Button } from '../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { ConnectionPicker } from './analysis-form/ConnectionPicker';
import { EndpointPanel } from './analysis-form/EndpointPanel';
import type { EndpointRole } from './analysis-form/EndpointPanel';
import { MigrationPath } from './analysis-form/MigrationPath';
import { NoConnectionsState } from './analysis-form/NoConnectionsState';
import { PreflightNotes } from './analysis-form/PreflightNotes';
import {
  describeDirection,
  isPlanComplete,
  planBlock,
  preflightNotes,
} from './analysis-form/preflight';

interface Props {
  onStart: (analysisId: string) => void;
}

const SAMPLE_SIZES = [1000, 5000, 10000, 25000] as const;

export function AnalysisForm({ onStart }: Props) {
  const { connections, currentConnection } = useConnection();
  const {
    sourceId,
    targetId,
    sourceChosen,
    scanSampleSize,
    chooseSource,
    chooseTarget,
    clearSource,
    clearTarget,
    setScanSampleSize,
  } = useMigrationPlan();
  const [picking, setPicking] = useState<EndpointRole | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCloudMode = import.meta.env.VITE_CLOUD_MODE === 'true';

  if (connections.length < 2) {
    return <NoConnectionsState connections={connections} />;
  }

  const findConnection = (id: string | null): Connection | null => {
    if (id === null) {
      return null;
    }
    return (
      connections.find((connection) => {
        return connection.id === id;
      }) ?? null
    );
  };

  const source = findConnection(sourceId);
  const target = findConnection(targetId);
  const direction = describeDirection(source, target);
  const block = planBlock(source, target);
  const notes = preflightNotes(source, target);
  const complete = isPlanComplete(source, target);
  const isPrefilled =
    source !== null && source.id === currentConnection?.id && sourceChosen === false;

  const offlineCount = connections.filter((connection) => {
    return connection.isConnected === false;
  }).length;
  const agentCount = connections.filter((connection) => {
    return connection.connectionType === 'agent';
  }).length;
  const selectableCount = connections.length - agentCount;

  const handleSelect = (connection: Connection) => {
    if (picking === 'source') {
      chooseSource(connection.id);
      return;
    }
    chooseTarget(connection.id);
  };

  const handleSubmit = async () => {
    if (source === null || target === null || block !== null) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetchApi<StartAnalysisResponse>('/migration/analysis', {
        method: 'POST',
        body: JSON.stringify({
          sourceConnectionId: source.id,
          targetConnectionId: target.id,
          scanSampleSize,
        }),
      });
      onStart(res.id);
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Failed to start analysis';
      if (/writeable|enableOfflineQueue|offline/i.test(raw)) {
        setError(
          `Could not connect to ${target.name} — the instance appears to be offline. Check the connection before running analysis.`,
        );
      } else {
        setError(raw);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="grid items-stretch gap-0 md:grid-cols-[1fr_13rem_1fr]">
        <EndpointPanel
          role="source"
          connection={source}
          isPrefilled={isPrefilled}
          selectableCount={selectableCount}
          offlineCount={offlineCount}
          agentCount={agentCount}
          onChoose={() => {
            setPicking('source');
          }}
          onClear={clearSource}
        />
        <MigrationPath direction={direction} />
        <EndpointPanel
          role="target"
          connection={target}
          isPrefilled={false}
          selectableCount={selectableCount}
          offlineCount={offlineCount}
          agentCount={agentCount}
          onChoose={() => {
            setPicking('target');
          }}
          onClear={clearTarget}
        />
      </div>

      {block !== null && (
        <p className="text-sm text-destructive" role="alert">
          {block}
        </p>
      )}

      {isCloudMode && (
        <p className="text-sm text-chart-warning">
          Migration execution is not available in BetterDB Cloud. Contact us at{' '}
          <a href="mailto:support@betterdb.com" className="underline">
            support@betterdb.com
          </a>{' '}
          to plan your migration.
        </p>
      )}

      {error !== null && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Button
          size="lg"
          disabled={loading || complete === false || block !== null}
          onClick={handleSubmit}
        >
          {loading && (
            <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
          )}
          {loading ? 'Starting...' : 'Start Analysis'}
        </Button>

        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground" htmlFor="scan-sample-size">
            Sample
          </label>
          <Select
            value={String(scanSampleSize)}
            onValueChange={(value) => {
              setScanSampleSize(Number(value));
            }}
          >
            <SelectTrigger id="scan-sample-size" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SAMPLE_SIZES.map((size) => {
                return (
                  <SelectItem key={size} value={String(size)}>
                    {size.toLocaleString()} keys
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">higher is more accurate, slower</span>
        </div>
      </div>

      <PreflightNotes notes={notes} />

      <ConnectionPicker
        open={picking !== null}
        role={picking ?? 'source'}
        connections={connections}
        selectedId={picking === 'source' ? sourceId : targetId}
        excludeId={picking === 'source' ? targetId : sourceId}
        onSelect={handleSelect}
        onOpenChange={(open) => {
          if (open === false) {
            setPicking(null);
          }
        }}
      />
    </div>
  );
}
