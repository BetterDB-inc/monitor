import type { ReactNode } from 'react';
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

const CAUSE_ORDER: readonly CaptureGapCause[] = ['server_evicted', 'fetch_limit', 'monitor_offline'];

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatWindow(windowMs: number): string {
  const hours = Math.round(windowMs / (60 * 60 * 1000));
  if (hours % 24 === 0 && hours >= 48) return `${hours / 24} days`;
  if (hours === 1) return 'hour';
  return `${hours} hours`;
}

function ThresholdCode({ log }: { log: LogCaptureLogSummary }) {
  return <code className="font-mono">{LOG_CAPTURE_THRESHOLD_PARAMETER[log.logType]}</code>;
}

function EvictedRemedy({ log }: { log: LogCaptureLogSummary }) {
  const retained = log.currentMaxLen === null ? 'only the newest' : `only the newest ${formatCount(log.currentMaxLen)}`;
  return (
    <>
      <p>
        The server keeps {retained} entries (<code className="font-mono">{log.configParameter}</code>)
        and more than that were logged between two polls, so the oldest were overwritten before
        BetterDB could read them.
      </p>
      {log.burstExceedsRecommendation && (
        <p className="mt-1">
          Bursts of up to {formatCount(log.peakEvictedArrivals)} entries arrived between polls, more
          than any retained length BetterDB recommends. Raise <ThresholdCode log={log} /> so fewer
          commands are logged.
        </p>
      )}
      {log.recommendedMaxLen !== null ? (
        <>
          <p className="mt-1">
            Raise it to at least {formatCount(log.recommendedMaxLen)}:{' '}
            <code className="font-mono">
              CONFIG SET {log.configParameter} {log.recommendedMaxLen}
            </code>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            On ElastiCache and MemoryDB, change it in the parameter group instead. On Redis Cloud,
            CONFIG SET works but the allowed range is 128-1024
            {log.recommendedMaxLen > 1024 ? '; use 1024 there and raise the threshold instead' : ''}.
          </p>
        </>
      ) : (
        !log.burstExceedsRecommendation && (
          <p className="mt-1">
            The current setting already covers the largest burst seen, so new gaps should stop.
          </p>
        )
      )}
    </>
  );
}

function CauseBlock({
  cause,
  log,
  maxFetchPerPoll,
  onlyCause,
}: {
  cause: CaptureGapCause;
  log: LogCaptureLogSummary;
  maxFetchPerPoll: number;
  onlyCause: boolean;
}) {
  let body: ReactNode;
  if (cause === 'server_evicted') {
    body = <EvictedRemedy log={log} />;
  } else if (cause === 'fetch_limit') {
    body = (
      <p>
        More than {formatCount(maxFetchPerPoll)} entries were logged between two polls, which is
        more than BetterDB reads in one poll. Raise <ThresholdCode log={log} /> so only the commands
        worth investigating are logged.
      </p>
    );
  } else {
    body = (
      <p>
        These entries were overwritten while BetterDB was not polling (a restart or an outage).
        {onlyCause ? ' No server change is needed.' : ''}
      </p>
    );
  }
  return (
    <div className={onlyCause ? undefined : 'mt-2'} data-testid={`log-capture-cause-${cause}`}>
      {!onlyCause && (
        <p className="text-xs font-medium text-muted-foreground">
          {formatCount(log.missingByCause[cause])} {CAUSE_LABELS[cause]}
        </p>
      )}
      {body}
    </div>
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

  const causes = CAUSE_ORDER.filter((cause) => log.missingByCause[cause] > 0);
  const offlineOnly =
    log.missingByCause.server_evicted === 0 &&
    log.missingByCause.fetch_limit === 0 &&
    log.missingByCause.monitor_offline > 0;
  const Icon = offlineOnly ? Info : AlertTriangle;
  const title = `${formatCount(log.missingEntries)} ${LOG_LABELS[logType]} ${
    log.missingEntries === 1 ? 'entry was' : 'entries were'
  } never captured in the last ${formatWindow(summary.windowMs)}`;

  return (
    <Alert className={offlineOnly ? undefined : 'border-yellow-500'} data-testid="log-capture-gap-advisory">
      <Icon className={offlineOnly ? 'w-4 h-4' : 'w-4 h-4 text-yellow-500'} />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {causes.map((cause) => (
          <CauseBlock
            key={cause}
            cause={cause}
            log={log}
            maxFetchPerPoll={summary.maxFetchPerPoll}
            onlyCause={causes.length === 1}
          />
        ))}
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

/**
 * Advisories for logs with retained gaps that this page cannot show (for
 * example command log gaps after the server lost COMMANDLOG), so history is
 * never hidden.
 */
export function UnviewableLogGapAdvisories({
  summary,
  viewableLogTypes,
}: {
  summary: LogCaptureSummary | null | undefined;
  viewableLogTypes: readonly CapturedLogType[];
}) {
  if (summary === null || summary === undefined) return null;
  return (
    <>
      {summary.logs
        .filter((log) => log.missingEntries > 0 && !viewableLogTypes.includes(log.logType))
        .map((log) => (
          <LogCaptureGapAdvisory key={log.logType} summary={summary} logType={log.logType} />
        ))}
    </>
  );
}
