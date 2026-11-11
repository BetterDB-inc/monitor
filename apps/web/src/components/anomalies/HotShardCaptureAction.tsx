import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { StartSessionModal } from '../../pages/monitor/start-session-modal';
import type { HotShardDetail } from '../../types/anomaly';
import { Button } from '../ui/button';

interface Props {
  event: { id: string; metricType: string; resolved?: boolean };
  hotShards: HotShardDetail[] | null | undefined;
  connectionId: string | undefined;
}

export function HotShardCaptureAction({ event, hotShards, connectionId }: Props) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  if (!connectionId || event.metricType !== 'hot_shard' || event.resolved) {
    return null;
  }
  const shard = hotShards?.find((detail) => detail.eventId === event.id);
  if (!shard?.captureAvailable) {
    return null;
  }
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        Capture on hot primary
      </Button>
      <StartSessionModal
        connectionId={connectionId}
        open={open}
        onOpenChange={setOpen}
        onStarted={(session) => navigate(`/monitor/sessions/${session.id}`)}
        hotPrimary={{ nodeId: shard.shardId, address: shard.nodeAddr }}
      />
    </>
  );
}
