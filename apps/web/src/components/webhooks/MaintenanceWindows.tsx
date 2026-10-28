import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff } from 'lucide-react';
import { WebhookEventType, type MaintenanceWindowView } from '@betterdb/shared';
import { maintenanceWindowsApi } from '../../api/maintenance-windows';
import { useConnection } from '../../hooks/useConnection';
import { useCanMutate } from '../../hooks/useCanMutate';
import { Card } from '../ui/card';
import { Badge } from '../ui/badge';
import { buildCreateRequest, DURATION_PRESETS, INITIAL_FORM, type FormState } from './maintenance-window-form';

const QUERY_KEY = ['maintenance-windows'] as const;

const ALL_EVENTS = Object.values(WebhookEventType);
const RECENT_ENDED_SHOWN = 5;

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function scopeLabel(window: MaintenanceWindowView, names: Map<string, string>): string {
  if (window.connectionId === null) return 'All connections';
  return names.get(window.connectionId) ?? window.connectionId;
}

function eventsLabel(window: MaintenanceWindowView): string {
  return window.events.length === 0 ? 'All events' : window.events.join(', ');
}

/**
 * Schedule, review and end maintenance windows. While a window is active,
 * matching webhook alerts are logged as "suppressed" instead of sent.
 */
export function MaintenanceWindows() {
  const queryClient = useQueryClient();
  const canMutate = useCanMutate();
  const { currentConnection, connections } = useConnection();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: windows = [], isError, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ signal }) => maintenanceWindowsApi.list(signal),
    refetchInterval: 30_000,
  });

  const names = new Map(connections.map((connection) => [connection.id, connection.name]));
  const active = windows.filter((window) => window.state === 'active');
  const scheduled = windows.filter((window) => window.state === 'scheduled');
  const ended = windows.filter((window) => window.state === 'ended').slice(0, RECENT_ENDED_SHOWN);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    const request = buildCreateRequest(form, currentConnection?.id ?? null, Date.now());
    if (typeof request === 'string') {
      setError(request);
      return;
    }
    if (await run(() => maintenanceWindowsApi.create(request))) {
      setForm(INITIAL_FORM);
      setShowForm(false);
    }
  };

  const toggleEvent = (eventType: WebhookEventType) => {
    setForm((prev) => ({
      ...prev,
      events: prev.events.includes(eventType)
        ? prev.events.filter((existing) => existing !== eventType)
        : [...prev.events, eventType],
    }));
  };

  return (
    <Card className="p-4 space-y-4" data-testid="maintenance-windows">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <BellOff className="w-4 h-4" /> Maintenance windows
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Pause webhook alerts during planned work (upgrades, failover drills, migrations). Alerts
            are still logged as suppressed, and anything still unresolved when the window ends is sent
            then.
          </p>
        </div>
        {!showForm && (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            disabled={!canMutate}
            title={canMutate ? undefined : 'Admins only'}
            className="px-3 py-1.5 text-sm border rounded-md hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            Schedule maintenance
          </button>
        )}
      </div>

      {isError && <p className="text-sm text-destructive">Could not load maintenance windows.</p>}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {active.map((window) => (
        <div
          key={window.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-yellow-500 bg-yellow-500/10 px-3 py-2"
          data-testid="active-window"
        >
          <div className="text-sm">
            <span className="font-medium">Alerts paused: {window.name}</span>
            <span className="text-muted-foreground">
              {' '}
              · {scopeLabel(window, names)} · {eventsLabel(window)} · until {formatTime(window.endsAt)}
            </span>
            {window.reason && <div className="text-xs text-muted-foreground">{window.reason}</div>}
          </div>
          <button
            type="button"
            disabled={!canMutate || busy}
            onClick={() => void run(() => maintenanceWindowsApi.end(window.id))}
            className="px-3 py-1 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
          >
            End now
          </button>
        </div>
      ))}

      {showForm && (
        <form onSubmit={handleCreate} className="space-y-3 border rounded-md p-3" aria-label="Schedule maintenance">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="mw-name" className="block text-sm font-medium mb-1">
                Name *
              </label>
              <input
                id="mw-name"
                value={form.name}
                maxLength={120}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 border rounded-md"
                placeholder="Valkey 8.1 upgrade"
              />
            </div>
            <div>
              <label htmlFor="mw-reason" className="block text-sm font-medium mb-1">
                Reason
              </label>
              <input
                id="mw-reason"
                value={form.reason}
                maxLength={500}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                className="w-full px-3 py-2 border rounded-md"
                placeholder="Change ticket or runbook link"
              />
            </div>
          </div>

          <fieldset className="text-sm space-y-1">
            <legend className="font-medium mb-1">Applies to</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="mw-scope"
                checked={!form.allConnections}
                onChange={() => setForm({ ...form, allConnections: false })}
              />
              This connection ({currentConnection?.name ?? 'none selected'})
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="mw-scope"
                checked={form.allConnections}
                onChange={() => setForm({ ...form, allConnections: true })}
              />
              All connections
            </label>
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="mw-start" className="block text-sm font-medium mb-1">
                Starts
              </label>
              <select
                id="mw-start"
                value={form.startMode}
                onChange={(e) => setForm({ ...form, startMode: e.target.value as FormState['startMode'] })}
                className="w-full px-3 py-2 border rounded-md dark:[color-scheme:dark]"
              >
                <option className="bg-card text-card-foreground" value="now">
                  Now
                </option>
                <option className="bg-card text-card-foreground" value="at">
                  At a later time
                </option>
              </select>
              {form.startMode === 'at' && (
                <input
                  type="datetime-local"
                  aria-label="Start time"
                  value={form.startAt}
                  onChange={(e) => setForm({ ...form, startAt: e.target.value })}
                  className="mt-2 w-full px-3 py-2 border rounded-md dark:[color-scheme:dark]"
                />
              )}
            </div>
            <div>
              <label htmlFor="mw-duration" className="block text-sm font-medium mb-1">
                Duration
              </label>
              <select
                id="mw-duration"
                value={form.durationMs}
                onChange={(e) => setForm({ ...form, durationMs: Number(e.target.value) })}
                className="w-full px-3 py-2 border rounded-md dark:[color-scheme:dark]"
              >
                {DURATION_PRESETS.map((preset) => (
                  <option key={preset.ms} className="bg-card text-card-foreground" value={preset.ms}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.limitEvents}
                onChange={(e) => setForm({ ...form, limitEvents: e.target.checked })}
              />
              Only silence specific events
            </label>
            {form.limitEvents && (
              <div className="mt-2 grid gap-1 sm:grid-cols-2 max-h-48 overflow-y-auto border rounded-md p-2">
                {ALL_EVENTS.map((eventType) => (
                  <label key={eventType} className="flex items-center gap-2 font-mono text-xs">
                    <input
                      type="checkbox"
                      checked={form.events.includes(eventType)}
                      onChange={() => toggleEvent(eventType)}
                    />
                    {eventType}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setError(null);
              }}
              className="px-3 py-1.5 text-sm border rounded-md hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
            >
              Pause alerts
            </button>
          </div>
        </form>
      )}

      {scheduled.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Scheduled</h3>
          {scheduled.map((window) => (
            <div key={window.id} className="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="scheduled-window">
              <span>
                {window.name}{' '}
                <span className="text-muted-foreground">
                  · {scopeLabel(window, names)} · {formatTime(window.startsAt)} – {formatTime(window.endsAt)}
                </span>
              </span>
              <button
                type="button"
                disabled={!canMutate || busy}
                onClick={() => void run(() => maintenanceWindowsApi.end(window.id))}
                className="px-2 py-0.5 text-xs border rounded-md hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          ))}
        </div>
      )}

      {ended.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-muted-foreground">Recently ended</h3>
          {ended.map((window) => (
            <div key={window.id} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">ended</Badge>
              {window.name} · {scopeLabel(window, names)} · {formatTime(window.startsAt)} –{' '}
              {formatTime(window.endedAt !== null ? Math.min(window.endedAt, window.endsAt) : window.endsAt)}
              {window.createdBy && <> · by {window.createdBy}</>}
            </div>
          ))}
        </div>
      )}

      {!isError && !isLoading && active.length === 0 && scheduled.length === 0 && !showForm && (
        <p className="text-sm text-muted-foreground">No maintenance scheduled. Alerts are being sent normally.</p>
      )}
    </Card>
  );
}
