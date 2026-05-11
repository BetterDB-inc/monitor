import { useEffect, useRef } from 'react';
import { Button } from '../../components/ui/button';
import { MonitorTailHandle, TailStatus } from '../../hooks/useMonitorTail';

interface Props {
  tail: MonitorTailHandle;
}

const STATUS_LABEL: Record<TailStatus, string> = {
  connecting: 'Connecting…',
  streaming: 'Streaming',
  paused: 'Paused',
  historical_complete: 'Replay complete',
  session_ended: 'Session ended',
  closed: 'Disconnected',
  error: 'Error',
};

const STATUS_TONE: Record<TailStatus, string> = {
  connecting: 'bg-muted text-muted-foreground',
  streaming: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  paused: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  historical_complete: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  session_ended: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  closed: 'bg-muted text-muted-foreground',
  error: 'bg-red-500/15 text-red-700 dark:text-red-300',
};

export function TailView({ tail }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followBottomRef = useRef(true);

  // Auto-scroll to bottom when new lines arrive, but only if the user has not
  // scrolled up. Detect "user scrolled up" by checking distance-from-bottom on
  // every render.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (followBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [tail.lines.length]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    followBottomRef.current = distanceFromBottom < 32;
  };

  const live = tail.status === 'streaming' || tail.status === 'paused';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_TONE[tail.status]}`}
          >
            {STATUS_LABEL[tail.status]}
          </span>
          <span className="text-xs text-muted-foreground">
            {tail.totalReceived.toLocaleString()} lines received
          </span>
          {tail.bufferTrimmed && (
            <span className="text-xs text-muted-foreground">
              · showing last {tail.lines.length.toLocaleString()} (older lines dropped)
            </span>
          )}
        </div>
        {live && (
          <div className="flex gap-2">
            {tail.paused ? (
              <Button size="sm" onClick={tail.resume}>
                Resume
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={tail.pause}>
                Pause
              </Button>
            )}
          </div>
        )}
      </div>

      {tail.errorMessage && (
        <p className="text-sm text-destructive">{tail.errorMessage}</p>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-[60vh] overflow-y-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[11px] leading-snug"
      >
        {tail.lines.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">
            {tail.status === 'connecting' ? 'Connecting…' : 'No lines yet.'}
          </p>
        ) : (
          tail.lines.map((line, i) => (
            <div key={i} className="whitespace-pre">
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
