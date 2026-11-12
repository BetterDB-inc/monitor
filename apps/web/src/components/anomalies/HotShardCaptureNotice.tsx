import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Info } from 'lucide-react';
import { metricsApi } from '../../api/metrics';
import { usePolling } from '../../hooks/usePolling';
import { StartSessionModal } from '../../pages/monitor/start-session-modal';
import type { HotShardDetail } from '../../types/anomaly';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Button } from '../ui/button';

const OPEN_EVENTS_POLL_MS = 5000;
const HOT_SHARDS_POLL_MS = 10000;

interface Props {
  connectionId: string | undefined;
}

interface Capture {
  connectionId: string;
  hotPrimary: { nodeId: string; address: string };
}

export function HotShardCaptureNotice({ connectionId }: Props) {
  const navigate = useNavigate();
  const opener = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (wasOpen.current && !open && opener.current?.isConnected) opener.current.focus();
    wasOpen.current = open;
  }, [open]);

  const { data: openEvents, error: eventsError } = usePolling({
    fetcher: () => metricsApi.getAnomalyEvents({ metricType: 'hot_shard', activeOnly: true }),
    interval: OPEN_EVENTS_POLL_MS,
    enabled: !!connectionId,
    refetchKey: connectionId,
  });
  const openIds = new Set(
    (openEvents ?? [])
      .filter((event) => event.metricType === 'hot_shard' && !event.resolved)
      .map((event) => event.id),
  );
  const hotShardOpen = openIds.size > 0;
  const { data: hotShards, error: hotShardsError } = usePolling<HotShardDetail[]>({
    fetcher: () => metricsApi.getHotShards(),
    interval: HOT_SHARDS_POLL_MS,
    enabled: hotShardOpen && !!connectionId,
    refetchKey: connectionId,
  });
  const offered =
    connectionId && !eventsError && !hotShardsError
      ? (hotShards ?? []).filter((shard) => shard.captureAvailable && openIds.has(shard.eventId))
      : [];

  return (
    <>
      {connectionId && offered.length > 0 && (
        <Alert>
          <Info className="w-4 h-4" />
          <AlertTitle>A capture can show the keys of a hot shard</AlertTitle>
          <AlertDescription>
            <ul className="space-y-2">
              {offered.map((shard) => (
                <li key={shard.eventId} className="flex items-center justify-between gap-3">
                  <span>
                    Hot shard {shard.shardId.substring(0, 8)} at {shard.nodeAddr} has no key names
                    {shard.keyNote ? `: ${shard.keyNote}` : ''}.
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={(e) => {
                      opener.current = e.currentTarget;
                      setCapture({
                        connectionId,
                        hotPrimary: { nodeId: shard.shardId, address: shard.nodeAddr },
                      });
                      setOpen(true);
                    }}
                  >
                    Capture on hot primary
                  </Button>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {capture && (
        <StartSessionModal
          connectionId={capture.connectionId}
          open={open}
          onOpenChange={setOpen}
          onStarted={(session) => navigate(`/monitor/sessions/${session.id}`)}
          hotPrimary={capture.hotPrimary}
        />
      )}
    </>
  );
}
