import { AlertTriangle, Info } from 'lucide-react';
import {
  LOG_CAPTURE_THRESHOLD_PARAMETER,
  type CaptureGapCause,
  type CapturedLogType,
  type LogCaptureLogSummary,
  type LogCaptureSummary,
} from '@betterdb/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';

const LOG_LABELS: Record<CapturedLogType, string> = {
  slowlog: 'slow log',
  'commandlog-slow': 'command log (slow)',
  'commandlog-large-request': 'command log (large request)',
  'commandlog-large-reply': 'command log (large reply)',
};

const CAUSE_LABELS: Record<CaptureGapCause, string> = {
  server_evicted: 'overwritten by the server',
  fetch_limit: 'over the per-poll read limit',
  monitor_offline: 'while BetterDB was not polling',
};

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatWindow(windowMs: number): string {
  const hours = Math.round(windowMs / (60 * 60 * 1000));
  if (hours % 24 === 0 && hours >= 48) return `${hours / 24} days`;
  if (hours === 1) return 'hour';
  return `${hours} hours`;
}

function CauseBreakdown({ log }: { log: LogCaptureLogSummary }) {
  const causes = (Object.keys(log.missingByCause) as CaptureGapCause[]).filter(
    (cause) => log.missingByCause[cause] > 0,
  );
  if (causes.length < 2) return null;
  return (
    <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
      {causes.map((cause) => (
        <li key={cause}>
          {formatCount(log.missingByCause[cause])} {CAUSE_LABELS[cause]}
        </li>
      ))}
    </ul>
  );
}

function Remedy({ log, maxFetchPerPoll }: { log: LogCaptureLogSummary; maxFetchPerPoll: number }) {
  if (log.dominantCause === 'monitor_offline') {
    return (
      <p>
        These entries were overwritten while BetterDB was not polling (a restart or an outage).
        No server change is needed.
      </p>
    );
  }

  if (log.dominantCause === 'fetch_limit') {
    return (
      <p>
        More than {formatCount(maxFetchPerPoll)} entries were logged between two polls, which is
        more than BetterDB reads in one poll. Raise{' '}
        <code className="font-mono">{LOG_CAPTURE_THRESHOLD_PARAMETER[log.logType]}</code> so only
        the commands worth investigating are logged.
      </p>
    );
  }

  const retained = log.currentMaxLen === null ? 'only the newest' : `only the newest ${formatCount(log.currentMaxLen)}`;
  return (
    <>
      <p>
        The server keeps {retained} entries (<code className="font-mono">{log.configParameter}</code>)
        and more than that were logged between two polls, so the oldest were overwritten before
        BetterDB could read them.
      </p>
      {log.recommendedMaxLen !== null ? (
        <p className="mt-1">
          Raise it to at least {formatCount(log.recommendedMaxLen)}:{' '}
          <code className="font-mono">
            CONFIG SET {log.configParameter} {log.recommendedMaxLen}
          </code>{' '}
          (on managed services, change it in the parameter group instead).
        </p>
      ) : (
        <p className="mt-1">
          The current setting already covers the largest burst seen, so new gaps should stop.
        </p>
      )}
    </>
  );
}

/**
 * Shown when entries of the visible log were lost before BetterDB could read
 * them. Everything on this page is built from what BetterDB persisted, so an
 * unflagged gap reads as "nothing slow happened" exactly when a burst did.
 */
export function LogCaptureGapAdvisory({
  summary,
  logType,
}: {
  summary: LogCaptureSummary | null | undefined;
  logType: CapturedLogType;
}) {
  const log = summary?.logs.find((candidate) => candidate.logType === logType);
  if (summary === null || summary === undefined || log === undefined || log.missingEntries === 0) {
    return null;
  }

  const offlineOnly = log.dominantCause === 'monitor_offline';
  const Icon = offlineOnly ? Info : AlertTriangle;
  const title = `${formatCount(log.missingEntries)} ${LOG_LABELS[logType]} ${
    log.missingEntries === 1 ? 'entry was' : 'entries were'
  } never captured in the last ${formatWindow(summary.windowMs)}`;

  return (
    <Alert className={offlineOnly ? undefined : 'border-yellow-500'} data-testid="log-capture-gap-advisory">
      <Icon className={offlineOnly ? 'w-4 h-4' : 'w-4 h-4 text-yellow-500'} />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <Remedy log={log} maxFetchPerPoll={summary.maxFetchPerPoll} />
        <CauseBreakdown log={log} />
        {log.lastGapAt !== null && (
          <p className="mt-1 text-xs text-muted-foreground">
            {log.gapCount === 1 ? '1 gap' : `${formatCount(log.gapCount)} gaps`} · last{' '}
            {new Date(log.lastGapAt).toLocaleString()}
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}
