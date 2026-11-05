import { AlertTriangle, CheckCircle2, CircleDashed, CircleDot, Repeat } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import type { IncidentTimeline, IncidentTimelineEntry } from '../../../types/anomaly';
import {
  SEVERITY_CONFIG,
  formatDateTime,
  formatDuration,
  formatTime,
  metricLabel,
  patternLabel,
} from '../anomaly-display';
import { IncidentStatusBadge } from './IncidentStatusBadge';
import { incidentDurationMs, isIncidentOpen, orderedEntries } from './incident-summary';

interface IncidentTimelineViewProps {
  incident: IncidentTimeline;
  now: number;
}

function recoveryText(entry: IncidentTimelineEntry): string {
  switch (entry.recoveryState) {
    case 'recovered':
      return entry.recoveredAt === null
        ? 'Back to baseline'
        : `Back to baseline at ${formatTime(entry.recoveredAt)} (after ${formatDuration(entry.recoveredAt - entry.timestamp)})`;
    case 'recurred':
      return 'Fired again later';
    case 'unknown':
      return 'Recovery unknown';
    default:
      return 'Not back to baseline';
  }
}

function RecoveryIcon({ entry }: { entry: IncidentTimelineEntry }) {
  switch (entry.recoveryState) {
    case 'recovered':
      return <CheckCircle2 className="w-4 h-4 text-green-500" aria-hidden />;
    case 'recurred':
      return <Repeat className="w-4 h-4 text-muted-foreground" aria-hidden />;
    case 'unknown':
      return <CircleDashed className="w-4 h-4 text-muted-foreground" aria-hidden />;
    default:
      return <CircleDot className="w-4 h-4 text-destructive" aria-hidden />;
  }
}

export function IncidentTimelineView({ incident, now }: IncidentTimelineViewProps) {
  const entries = orderedEntries(incident);
  const stepOf = new Map<string, number>();
  for (const match of incident.sequenceMatches) {
    match.anomalyIds.forEach((id, i) => {
      if (!stepOf.has(id)) stepOf.set(id, i + 1);
    });
  }
  const duration = formatDuration(incidentDurationMs(incident, now));
  const title =
    incident.matchedPatterns.length > 0
      ? incident.matchedPatterns.map(patternLabel).join(', ')
      : 'Incident';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold">{title}</h1>
        <IncidentStatusBadge status={incident.recovery.status} />
      </div>
      <p className="text-sm text-muted-foreground">
        Started {formatDateTime(incident.startedAt)} ·{' '}
        {isIncidentOpen(incident) ? `${duration} so far` : duration} · {incident.entries.length}{' '}
        event{incident.entries.length === 1 ? '' : 's'} across {incident.connectionIds.length}{' '}
        connection{incident.connectionIds.length === 1 ? '' : 's'}
      </p>

      {incident.recovery.status === 'degraded' && (
        <div
          role="alert"
          className="flex gap-3 rounded-lg border border-yellow-500 bg-yellow-500/10 p-4"
        >
          <AlertTriangle className="w-5 h-5 shrink-0 text-yellow-500" aria-hidden />
          <div className="space-y-1">
            <p className="font-semibold">
              Recovery debt: the cluster has not returned to its pre-incident state
            </p>
            <p className="text-sm text-muted-foreground">
              No new anomalies have fired, but{' '}
              {incident.recovery.openSignals.length > 0
                ? `${incident.recovery.openSignals.map(metricLabel).join(', ')} ${incident.recovery.openSignals.length === 1 ? 'is' : 'are'} still away from baseline.`
                : 'some signals are still away from baseline.'}
            </p>
          </div>
        </div>
      )}

      {incident.sequenceMatches.map((match) => (
        <Card
          key={`${match.pattern}-${match.anomalyIds.join(',')}`}
          className={SEVERITY_CONFIG[match.severity].border}
        >
          <CardHeader>
            <CardTitle className="text-lg">
              Matched sequence: {patternLabel(match.pattern)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{match.diagnosis}</p>
            <ol className="space-y-1 text-sm">
              {match.anomalyIds.map((id, i) => {
                const entry = incident.entries.find((e) => e.anomalyId === id);
                return (
                  <li key={id} className="flex gap-2">
                    <span className="font-mono text-primary">{i + 1}.</span>
                    <span>{entry ? metricLabel(entry.metricType) : id}</span>
                  </li>
                );
              })}
            </ol>
            {match.recommendations.length > 0 && (
              <ul className="space-y-1 text-sm">
                {match.recommendations.map((rec, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="text-primary mt-0.5">•</span>
                    <span className="text-muted-foreground">{rec}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="relative space-y-4 border-l pl-6">
            {entries.map((entry) => {
              const severity = SEVERITY_CONFIG[entry.severity];
              const step = stepOf.get(entry.anomalyId);
              return (
                <li key={entry.anomalyId} data-testid="incident-entry" className="relative">
                  <span
                    className={`absolute -left-[1.85rem] top-1 h-3 w-3 rounded-full ${severity.bg} border ${severity.border}`}
                  />
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-mono text-muted-foreground">
                      {formatTime(entry.timestamp)}
                    </span>
                    <span className="font-semibold">{metricLabel(entry.metricType)}</span>
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${severity.bg} ${severity.color}`}
                    >
                      {entry.severity.toUpperCase()}
                    </span>
                    {step !== undefined && (
                      <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        Step {step}
                      </span>
                    )}
                    {entry.nodeAddr && (
                      <span className="text-xs text-muted-foreground">{entry.nodeAddr}</span>
                    )}
                  </div>
                  <p className="text-sm">{entry.message}</p>
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <RecoveryIcon entry={entry} />
                    {recoveryText(entry)}
                  </p>
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
