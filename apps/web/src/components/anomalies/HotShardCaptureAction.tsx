import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { StartSessionModal } from '../../pages/monitor/start-session-modal';
import type { HotShardDetail } from '../../types/anomaly';
import { Button } from '../ui/button';

interface Props {
  event: { id: string; metricType: string; resolved?: boolean };
  hotShards: HotShardDetail[] | null | undefined;
  connectionId: string | undefined;
}

interface Capture {
  connectionId: string;
  hotPrimary: { nodeId: string; address: string };
}

export function HotShardCaptureAction({ event, hotShards, connectionId }: Props) {
  const navigate = useNavigate();
  const action = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (wasOpen.current && !open) action.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const hot = event.metricType === 'hot_shard' && !event.resolved;
  const shard = hot ? hotShards?.find((detail) => detail.eventId === event.id) : undefined;
  const offered = connectionId && shard?.captureAvailable ? { connectionId, shard } : undefined;
  return (
    <>
      {offered && (
        <Button
          ref={action}
          size="sm"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            setCapture({
              connectionId: offered.connectionId,
              hotPrimary: { nodeId: offered.shard.shardId, address: offered.shard.nodeAddr },
            });
            setOpen(true);
          }}
        >
          Capture on hot primary
        </Button>
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
