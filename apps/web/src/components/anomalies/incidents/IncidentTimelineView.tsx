import { CheckCircle2, CircleDashed, CircleDot, Repeat } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import type { IncidentTimeline, IncidentTimelineEntry } from '../../../types/anomaly';
import { SEVERITY_CONFIG, formatTime, metricLabel, patternLabel } from '../anomaly-display';
import { formatDateTime, formatDuration } from '../../../lib/formatters';
import { IncidentNotice } from './IncidentNotice';
import { IncidentStatusBadge } from './IncidentStatusBadge';
import { LiveDuration } from './LiveDuration';
import { incidentSubject, incidentTitle, type IncidentConnection } from './incident-summary';

interface IncidentTimelineViewProps {
  incident: IncidentTimeline;
  now?: number;
  connections?: IncidentConnection[];
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function recoveryTime(firedAt: number, recoveredAt: number): string {
  return sameDay(firedAt, recoveredAt) ? formatTime(recoveredAt) : formatDateTime(recoveredAt);
}

function recoveryText(entry: IncidentTimelineEntry): string {
  switch (entry.recoveryState) {
    case 'recovered': {
      const recoveredAt = entry.recoveredAt ?? entry.timestamp;
      return `Back to baseline at ${recoveryTime(entry.timestamp, recoveredAt)} (after ${formatDuration(recoveredAt - entry.timestamp)})`;
    }
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

export function IncidentTimelineView({
  incident,
  now,
  connections = [],
}: IncidentTimelineViewProps) {
  const entries = incident.entries;
  const namePattern = incident.sequenceMatches.length > 1;
  const entryById = new Map(incident.entries.map((entry) => [entry.anomalyId, entry]));
  const stepsOf = new Map<string, { key: string; label: string }[]>();
  incident.sequenceMatches.forEach((match, matchIndex) => {
    match.steps.forEach(({ anomalyId, step }, i) => {
      const label = step === null ? 'Supporting signal' : `Step ${step}`;
      const tags = stepsOf.get(anomalyId) ?? [];
      tags.push({
        key: `${matchIndex}:${i}`,
        label: namePattern ? `${patternLabel(match.pattern)}: ${label}` : label,
      });
      stepsOf.set(anomalyId, tags);
    });
  });
  const connectionCount = incident.connectionIds.length;
  const spansDays = entries.some((e) => !sameDay(e.timestamp, incident.startedAt));
  const eventTime = spansDays ? formatDateTime : formatTime;
  const title = incidentTitle(incident);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold">{title}</h1>
        <IncidentStatusBadge status={incident.recovery.status} />
      </div>
      <p className="text-sm text-muted-foreground">
        Started {formatDateTime(incident.startedAt)} ·{' '}
        <LiveDuration incident={incident} now={now} /> · {incident.entries.length} event
        {incident.entries.length === 1 ? '' : 's'}
        {connectionCount > 0 &&
          ` across ${connectionCount} connection${connectionCount === 1 ? '' : 's'}`}
      </p>

      {incident.recovery.status === 'degraded' && (
        <IncidentNotice
          role="alert"
          title={`Recovery debt: ${incidentSubject(incident, connections)} has not returned to its pre-incident state`}
        >
          No new anomalies have fired, but{' '}
          {incident.recovery.openSignals.map(metricLabel).join(', ')}{' '}
          {incident.recovery.openSignals.length === 1 ? 'is' : 'are'} still away from baseline.
        </IncidentNotice>
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
              {match.steps.map(({ anomalyId: id, step }) => {
                const entry = entryById.get(id);
                return (
                  <li key={id} className="flex gap-2">
                    <span className="font-mono text-primary">
                      {step === null ? '+' : `${step}.`}
                    </span>
                    <span>
                      {entry ? metricLabel(entry.metricType) : id}
                      {step === null && (
                        <span className="text-muted-foreground"> (supporting signal)</span>
                      )}
                    </span>
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
            {match.values && match.values.length > 0 && (
              <ul className="space-y-1 text-sm font-mono">
                {match.values.map((v) => (
                  <li key={`${v.nodeAddr ?? ''}:${v.setting}`}>
                    {v.setting}
                    {v.nodeAddr ? ` (${v.nodeAddr})` : ''}: {v.current} → {v.target} {v.unit}
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
              const steps = stepsOf.get(entry.anomalyId) ?? [];
              return (
                <li key={entry.anomalyId} data-testid="incident-entry" className="relative">
                  <span
                    className={`absolute -left-[1.85rem] top-1 h-3 w-3 rounded-full ${severity.bg} border ${severity.border}`}
                  />
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-mono text-muted-foreground">
                      {eventTime(entry.timestamp)}
                    </span>
                    <span className="font-semibold">{metricLabel(entry.metricType)}</span>
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${severity.bg} ${severity.color}`}
                    >
                      {entry.severity.toUpperCase()}
                    </span>
                    {steps.map((tag) => (
                      <span
                        key={tag.key}
                        className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                      >
                        {tag.label}
                      </span>
                    ))}
                    {entry.nodeAddr && (
                      <span className="text-xs text-muted-foreground">{entry.nodeAddr}</span>
                    )}
                  </div>
                  <p className="text-sm">{entry.message}</p>
                  {entry.values && entry.values.length > 0 && (
                    <ul className="space-y-1 text-sm font-mono">
                      {entry.values.map((v) => (
                        <li key={`${v.nodeAddr ?? ''}:${v.setting}`}>
                          {v.setting}
                          {v.nodeAddr ? ` (${v.nodeAddr})` : ''}: {v.current} → {v.target} {v.unit}
                        </li>
                      ))}
                    </ul>
                  )}
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
