import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { LogCaptureLogSummary, LogCaptureSummary } from '@betterdb/shared';
import { LogCaptureGapAdvisory } from './LogCaptureGapAdvisory';

function log(overrides: Partial<LogCaptureLogSummary> = {}): LogCaptureLogSummary {
  return {
    logType: 'slowlog',
    missingEntries: 1240,
    gapCount: 3,
    lastGapAt: 1_800_000_000_000,
    dominantCause: 'server_evicted',
    missingByCause: { server_evicted: 1240, fetch_limit: 0, monitor_offline: 0 },
    configParameter: 'slowlog-max-len',
    currentMaxLen: 128,
    recommendedMaxLen: 1024,
    ...overrides,
  };
}

function summary(logs: LogCaptureLogSummary[]): LogCaptureSummary {
  return {
    connectionId: 'conn-1',
    windowMs: 24 * 60 * 60 * 1000,
    since: 0,
    computedAt: 0,
    totalMissingEntries: logs.reduce((sum, entry) => sum + entry.missingEntries, 0),
    maxFetchPerPoll: 1024,
    logs,
  };
}

describe('LogCaptureGapAdvisory', () => {
  it('renders nothing without data, for another log, or when nothing was lost', () => {
    const { container, rerender } = render(<LogCaptureGapAdvisory summary={undefined} logType="slowlog" />);
    expect(container).toBeEmptyDOMElement();

    rerender(<LogCaptureGapAdvisory summary={summary([log()])} logType="commandlog-slow" />);
    expect(container).toBeEmptyDOMElement();

    rerender(
      <LogCaptureGapAdvisory
        summary={summary([log({ missingEntries: 0, gapCount: 0, dominantCause: null, lastGapAt: null })])}
        logType="slowlog"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('explains server eviction and gives the exact CONFIG SET to run', () => {
    render(<LogCaptureGapAdvisory summary={summary([log()])} logType="slowlog" />);
    expect(screen.getByText('1,240 slow log entries were never captured in the last 24 hours')).toBeInTheDocument();
    expect(screen.getByText(/only the newest 128 entries/)).toBeInTheDocument();
    expect(screen.getByText('CONFIG SET slowlog-max-len 1024')).toBeInTheDocument();
    expect(screen.getByText(/parameter group/)).toBeInTheDocument();
    expect(screen.getByText(/3 gaps/)).toBeInTheDocument();
  });

  it('says the setting already covers the burst when there is no recommendation', () => {
    render(
      <LogCaptureGapAdvisory
        summary={summary([log({ recommendedMaxLen: null, currentMaxLen: 4096 })])}
        logType="slowlog"
      />,
    );
    expect(screen.getByText(/already covers the largest burst/)).toBeInTheDocument();
    expect(screen.queryByText(/CONFIG SET/)).not.toBeInTheDocument();
  });

  it('points at the logging threshold when the per-poll read limit was the cause', () => {
    render(
      <LogCaptureGapAdvisory
        summary={summary([
          log({
            logType: 'commandlog-large-reply',
            configParameter: 'commandlog-large-reply-max-len',
            dominantCause: 'fetch_limit',
            missingByCause: { server_evicted: 0, fetch_limit: 1240, monitor_offline: 0 },
          }),
        ])}
        logType="commandlog-large-reply"
      />,
    );
    expect(screen.getByText(/command log \(large reply\) entries were never captured/)).toBeInTheDocument();
    expect(screen.getByText('commandlog-reply-larger-than')).toBeInTheDocument();
    expect(screen.getByText(/more than BetterDB reads in one poll/)).toBeInTheDocument();
  });

  it('does not ask for a server change when BetterDB itself was offline', () => {
    render(
      <LogCaptureGapAdvisory
        summary={summary([
          log({
            missingEntries: 1,
            gapCount: 1,
            dominantCause: 'monitor_offline',
            missingByCause: { server_evicted: 0, fetch_limit: 0, monitor_offline: 1 },
          }),
        ])}
        logType="slowlog"
      />,
    );
    expect(screen.getByText('1 slow log entry was never captured in the last 24 hours')).toBeInTheDocument();
    expect(screen.getByText(/No server change is needed/)).toBeInTheDocument();
  });

  it('breaks the total down by cause when more than one cause contributed', () => {
    render(
      <LogCaptureGapAdvisory
        summary={summary([
          log({ missingByCause: { server_evicted: 1000, fetch_limit: 0, monitor_offline: 240 } }),
        ])}
        logType="slowlog"
      />,
    );
    expect(screen.getByText('1,000 overwritten by the server')).toBeInTheDocument();
    expect(screen.getByText('240 while BetterDB was not polling')).toBeInTheDocument();
  });
});
