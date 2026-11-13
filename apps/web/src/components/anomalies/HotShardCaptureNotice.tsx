import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Info } from 'lucide-react';
import { useOpenHotShards } from '../../hooks/useOpenHotShards';
import { StartSessionModal } from '../../pages/monitor/start-session-modal';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Button } from '../ui/button';

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

  const offered = useOpenHotShards(connectionId).filter((shard) => shard.captureAvailable);

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
