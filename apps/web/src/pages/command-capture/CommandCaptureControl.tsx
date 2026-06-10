import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useConnection } from '../../hooks/useConnection';
import { usePolling } from '../../hooks/usePolling';
import { commandCaptureApi, type StoredCommandCaptureSession } from '../../api/command-capture';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent } from '../../components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';

type Unit = 's' | 'm';

const DURATION_PRESETS: Array<{ label: string; seconds: number }> = [
  { label: '30s', seconds: 30 },
  { label: '1m', seconds: 60 },
  { label: '5m', seconds: 300 },
  { label: '15m', seconds: 900 },
  { label: '1h', seconds: 3600 },
];

function formatCountdown(expiresAt: number): string {
  const remaining = Math.max(0, expiresAt - Date.now());
  const secs = Math.floor(remaining / 1000);
  if (secs >= 60) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}m ${s}s`;
  }
  return `${secs}s`;
}

export function CommandCaptureControl() {
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id;
  const queryClient = useQueryClient();

  const queryKey = useMemo(
    () => ['command-capture', 'session', connectionId ?? 'none'],
    [connectionId],
  );

  const sessionQuery = usePolling<StoredCommandCaptureSession | null>({
    fetcher: () =>
      connectionId
        ? commandCaptureApi.getSession(connectionId)
        : Promise.resolve(null),
    interval: 5000,
    enabled: !!connectionId,
    queryKey,
    refetchKey: connectionId,
  });

  const session = sessionQuery.data;
  const isActive = session?.status === 'active' && session.expiresAt > Date.now();

  // Countdown timer
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [isActive]);

  // Start form state
  const [duration, setDuration] = useState(30);
  const [unit, setUnit] = useState<Unit>('s');
  const [commandCap, setCommandCap] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const durationMs = unit === 'm' ? duration * 60 * 1000 : duration * 1000;

  const handleStart = useCallback(async () => {
    if (!connectionId) return;
    setSubmitting(true);
    setError(null);
    try {
      await commandCaptureApi.start({
        connectionId,
        durationMs,
        commandCap: commandCap ? parseInt(commandCap, 10) : undefined,
      });
      await queryClient.invalidateQueries({ queryKey });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [connectionId, durationMs, commandCap, queryClient, queryKey]);

  const handleStop = useCallback(async () => {
    if (!connectionId) return;
    setSubmitting(true);
    setError(null);
    try {
      await commandCaptureApi.stop(connectionId);
      await queryClient.invalidateQueries({ queryKey });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [connectionId, queryClient, queryKey]);

  const handlePreset = useCallback((seconds: number) => {
    if (seconds >= 60) {
      setDuration(seconds / 60);
      setUnit('m');
    } else {
      setDuration(seconds);
      setUnit('s');
    }
  }, []);

  if (!connectionId) {
    return null;
  }

  return (
    <Card>
      <CardContent className="p-4">
        <h3 className="text-sm font-semibold mb-3">Command Capture</h3>

        {isActive && session ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-sm font-medium">Capturing</span>
              <span className="text-sm text-muted-foreground ml-auto">
                {formatCountdown(session.expiresAt)} remaining
              </span>
            </div>

            <div className="text-xs text-muted-foreground space-y-1">
              <div>Commands captured: <span className="font-mono">{session.commandCount.toLocaleString()}</span></div>
              {session.commandCap && (
                <div>
                  Command cap: <span className="font-mono">{session.commandCap.toLocaleString()}</span>
                </div>
              )}
            </div>

            <Button
              variant="destructive"
              size="sm"
              onClick={handleStop}
              disabled={submitting}
              className="w-full"
            >
              {submitting ? 'Stopping…' : 'Stop Capture'}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-1 flex-wrap">
              {DURATION_PRESETS.map((p) => (
                <Button
                  key={p.label}
                  variant="outline"
                  size="sm"
                  className="text-xs h-7 px-2"
                  onClick={() => handlePreset(p.seconds)}
                >
                  {p.label}
                </Button>
              ))}
            </div>

            <div className="flex gap-2">
              <Input
                type="number"
                min={1}
                value={duration}
                onChange={(e) => setDuration(parseInt(e.target.value, 10) || 1)}
                className="w-20"
              />
              <Select value={unit} onValueChange={(v) => setUnit(v as Unit)}>
                <SelectTrigger className="w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="s">sec</SelectItem>
                  <SelectItem value="m">min</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-xs text-muted-foreground">
                Max commands (optional)
              </label>
              <Input
                type="number"
                min={1}
                placeholder="No limit"
                value={commandCap}
                onChange={(e) => setCommandCap(e.target.value)}
                className="mt-1"
              />
            </div>

            <Button
              size="sm"
              onClick={handleStart}
              disabled={submitting || duration <= 0}
              className="w-full"
            >
              {submitting ? 'Starting…' : 'Start Capture'}
            </Button>

            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
