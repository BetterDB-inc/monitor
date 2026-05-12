import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { StoredCaptureSession } from '@betterdb/shared';
import { monitorApi } from '../../api/monitor';
import { Button } from '../../components/ui/button';
import { CrossReferenceSections } from './cross-reference-panel';

interface Props {
  sessionId: string;
  connectionId: string;
}

const COMPLETED_STATUSES = new Set<StoredCaptureSession['status']>([
  'completed',
  'truncated',
]);

export function CompareCapturesPanel({ sessionId, connectionId }: Props) {
  const [selectedOtherId, setSelectedOtherId] = useState<string>('');
  const [compareTargetId, setCompareTargetId] = useState<string | undefined>();

  const { data: candidates, isLoading: candidatesLoading } = useQuery({
    queryKey: ['monitor', 'sessions', connectionId, 'compare-candidates'],
    queryFn: () => monitorApi.listSessions({ connectionId, limit: 100 }),
  });

  const otherSessions = useMemo(() => {
    if (!candidates) {
      return [];
    }
    return candidates
      .filter((s) => s.id !== sessionId && COMPLETED_STATUSES.has(s.status))
      .sort((a, b) => b.startedAt - a.startedAt);
  }, [candidates, sessionId]);

  const { data, error, isFetching } = useQuery({
    queryKey: ['monitor', 'session-diff', sessionId, compareTargetId],
    queryFn: () => monitorApi.compareSessions(sessionId, compareTargetId!),
    enabled: !!compareTargetId,
    refetchOnWindowFocus: false,
  });

  function handleCompare() {
    if (!selectedOtherId) {
      return;
    }
    setCompareTargetId(selectedOtherId);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[260px]">
          <label htmlFor="compare-other" className="text-xs uppercase tracking-wide text-muted-foreground">
            Compare against
          </label>
          <select
            id="compare-other"
            className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-xs"
            value={selectedOtherId}
            onChange={(e) => setSelectedOtherId(e.target.value)}
            disabled={candidatesLoading || otherSessions.length === 0}
          >
            <option value="">{otherSessions.length === 0 ? 'No other completed captures on this connection' : 'Select a capture…'}</option>
            {otherSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id.slice(0, 8)} · {new Date(s.startedAt).toLocaleString()} · {s.lineCount.toLocaleString()} lines
              </option>
            ))}
          </select>
        </div>
        <Button
          size="sm"
          onClick={handleCompare}
          disabled={!selectedOtherId || isFetching}
        >
          {isFetching ? 'Comparing…' : 'Compare'}
        </Button>
      </div>

      {error && (
        <p className="text-sm text-destructive">
          Compare failed: {(error as Error).message}
        </p>
      )}

      {data && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Diff against capture{' '}
            <span className="font-mono">{data.baseline.sessionId?.slice(0, 8)}</span>
            {data.baseline.startTs > 0 && (
              <> · started {new Date(data.baseline.startTs).toLocaleString()}</>
            )}
          </p>
          <CrossReferenceSections result={data} />
        </div>
      )}
    </div>
  );
}
