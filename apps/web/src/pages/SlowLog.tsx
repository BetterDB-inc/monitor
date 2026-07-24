import { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { metricsApi } from '../api/metrics';
import { usePolling } from '../hooks/usePolling';
import { useCapabilities } from '../hooks/useCapabilities';
import { useConnection } from '../hooks/useConnection';
import { useStoredSlowLog } from '../hooks/useStoredSlowLog';
import { useStoredCommandLog, COMMAND_LOG_PAGE_SIZE } from '../hooks/useStoredCommandLog';
import { useStoredCommandLogPatterns } from '../hooks/useStoredCommandLogPatterns';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { SlowLogTable } from '../components/metrics/SlowLogTable';
import { CommandLogTable } from '../components/metrics/CommandLogTable';
import { SlowLogPatternAnalysisView } from '../components/metrics/SlowLogPatternAnalysis';
import { ScanSkewAdvisory } from '../components/metrics/ScanSkewAdvisory';
import { DateRangePicker, DateRange } from '../components/ui/date-range-picker';
import { CapabilityStatusBanner } from '../components/CapabilityStatusBanner';
import type { CommandLogType, LogSortBy } from '../types/metrics';

function getTabFromParams(params: URLSearchParams): CommandLogType {
  const tab = params.get('tab');
  if (tab === 'large-request' || tab === 'large-reply') {
    return tab;
  }
  return 'slow';
}

function filterByClient<T extends { clientName: string; clientAddress: string }>(
  entries: T[],
  clientFilter: string | null
): T[] {
  if (!clientFilter) return entries;
  const filter = clientFilter.toLowerCase();
  return entries.filter(
    (e) =>
      e.clientName?.toLowerCase().includes(filter) ||
      e.clientAddress?.toLowerCase().includes(filter)
  );
}

export function SlowLog() {
  const { currentConnection } = useConnection();
  const { hasCommandLog, hasSlowLog, capabilities, reasons, retryCapability } = useCapabilities();
  const slowLogReason = reasons.canSlowLog;
  const commandLogReason = reasons.canCommandLog;
  const handleRetrySlowLog = retryCapability
    ? () => retryCapability('canSlowLog')
    : undefined;
  const handleRetryCommandLog = retryCapability
    ? () => retryCapability('canCommandLog')
    : undefined;
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = getTabFromParams(searchParams);
  const clientFilter = searchParams.get('client');
  const [viewMode, setViewMode] = useState<'table' | 'patterns'>('table');
  const [sortBy, setSortBy] = useState<LogSortBy>('recent');

  // Pagination state (only for stored/filtered data)
  const PAGE_SIZE = COMMAND_LOG_PAGE_SIZE;
  const [page, setPage] = useState(0);

  // Time filter state — initialise from URL ?start=&end= (epoch ms)
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => {
    const s = searchParams.get('start');
    const e = searchParams.get('end');
    if (s && e) {
      const from = new Date(Number(s));
      const to = new Date(Number(e));
      if (!isNaN(from.getTime()) && !isNaN(to.getTime())) return { from, to };
    }
    return undefined;
  });

  const handleDateRangeChange = (range: DateRange | undefined) => {
    setDateRange(range);
    setPage(0); // Reset to first page when date range changes
  };

  // Convert date range to Unix timestamps (seconds) - only filter when dateRange is set
  const startTime = dateRange?.from
    ? Math.floor(dateRange.from.getTime() / 1000)
    : undefined;
  const endTime = dateRange?.to
    ? Math.floor(dateRange.to.getTime() / 1000)
    : undefined;

  const handleTabChange = (newTab: CommandLogType) => {
    if (newTab === 'slow') {
      searchParams.delete('tab');
    } else {
      searchParams.set('tab', newTab);
    }
    setSearchParams(searchParams);
    setPage(0); // Reset to first page when changing tabs
  };

  // When time range is set, use stored log from persistence layer
  // When no time range, use live polling from Valkey
  const isTimeFiltered = startTime !== undefined && endTime !== undefined;
  // Magnitude sort ranks the durable store (worst offenders can be older than
  // Valkey's small in-memory buffer), so it always reads stored data.
  const useStoredData = isTimeFiltered || sortBy === 'magnitude';

  const handleSortChange = (next: LogSortBy) => {
    setSortBy(next);
    setPage(0);
  };

  // === SLOW LOG (non-Valkey or Redis) ===
  // Live polling (no time filter)
  const { data: liveSlowLog } = usePolling({
    fetcher: () => metricsApi.getSlowLog(100, true),
    interval: 10000,
    enabled: !hasCommandLog && !useStoredData,
    refetchKey: currentConnection?.id,
  });

  // Stored slow log (with time filter)
  const { data: storedSlowLog } = useStoredSlowLog({
    connectionId: currentConnection?.id,
    startTime,
    endTime,
    sortBy,
    enabled: useStoredData && !hasCommandLog,
  });

  // Use stored data when filtered or magnitude-sorted, live data otherwise
  const slowLog = useStoredData ? storedSlowLog : liveSlowLog;

  // === COMMAND LOG (Valkey-specific) ===
  // Live polling (no time filter)
  const { data: liveCommandLogSlow } = usePolling({
    fetcher: () => metricsApi.getCommandLog(100, 'slow'),
    interval: 10000,
    enabled: hasCommandLog && activeTab === 'slow' && !useStoredData,
    refetchKey: currentConnection?.id,
  });

  const { data: liveCommandLogLargeRequest } = usePolling({
    fetcher: () => metricsApi.getCommandLog(100, 'large-request'),
    interval: 10000,
    enabled: hasCommandLog && activeTab === 'large-request' && !useStoredData,
    refetchKey: currentConnection?.id,
  });

  const { data: liveCommandLogLargeReply } = usePolling({
    fetcher: () => metricsApi.getCommandLog(100, 'large-reply'),
    interval: 10000,
    enabled: hasCommandLog && activeTab === 'large-reply' && !useStoredData,
    refetchKey: currentConnection?.id,
  });

  // Stored command log (with time filter and pagination)
  const { data: storedCommandLogResult } = useStoredCommandLog({
    connectionId: currentConnection?.id,
    startTime,
    endTime,
    activeTab,
    page,
    sortBy,
    enabled: useStoredData && hasCommandLog,
  });
  const storedCommandLogEntries = storedCommandLogResult?.entries ?? null;
  const hasMoreEntries = storedCommandLogResult?.hasMore ?? false;

  // Use stored data when filtered or magnitude-sorted, live data otherwise
  const commandLogSlow = useStoredData ? (activeTab === 'slow' ? storedCommandLogEntries : null) : liveCommandLogSlow;
  const commandLogLargeRequest = useStoredData ? (activeTab === 'large-request' ? storedCommandLogEntries : null) : liveCommandLogLargeRequest;
  const commandLogLargeReply = useStoredData ? (activeTab === 'large-reply' ? storedCommandLogEntries : null) : liveCommandLogLargeReply;

  // Pattern analysis (less frequent polling since it's analytical)
  // Live pattern analysis (no time filter)
  const { data: liveSlowLogPatternAnalysis } = usePolling({
    fetcher: () => metricsApi.getSlowLogPatternAnalysis(128),
    interval: 30000,
    enabled: !hasCommandLog && viewMode === 'patterns' && !isTimeFiltered,
    refetchKey: currentConnection?.id,
  });

  const { data: liveCommandLogPatternAnalysis } = usePolling({
    fetcher: () =>
      metricsApi.getCommandLogPatternAnalysis(128, activeTab),
    interval: 30000,
    enabled: hasCommandLog && viewMode === 'patterns' && !isTimeFiltered,
    refetchKey: currentConnection?.id,
  });

  // SCAN large-reply / hash-skew advisory (valkey#3955) — rides the stored
  // large-reply log, so it works the same with or without a time filter.
  const { data: scanSkewReport } = usePolling({
    fetcher: () => metricsApi.getScanSkewAnalysis({ startTime, endTime }),
    interval: 30000,
    enabled: hasCommandLog && activeTab === 'large-reply',
    refetchKey: `${currentConnection?.id ?? 'none'}:${startTime ?? ''}:${endTime ?? ''}`,
  });

  // Stored pattern analysis (with time filter)
  const { data: storedCommandLogPatternAnalysis } = useStoredCommandLogPatterns({
    connectionId: currentConnection?.id,
    startTime,
    endTime,
    activeTab,
    enabled: isTimeFiltered && hasCommandLog && viewMode === 'patterns',
  });

  // Use stored data when filtered, live data otherwise
  const slowLogPatternAnalysis = liveSlowLogPatternAnalysis;
  const commandLogPatternAnalysis = isTimeFiltered ? storedCommandLogPatternAnalysis : liveCommandLogPatternAnalysis;

  const filteredSlowLog = useMemo(
    () => filterByClient(slowLog || [], clientFilter),
    [slowLog, clientFilter]
  );

  const filteredCommandLogSlow = useMemo(
    () => filterByClient(commandLogSlow || [], clientFilter),
    [commandLogSlow, clientFilter]
  );

  const filteredCommandLogLargeRequest = useMemo(
    () => filterByClient(commandLogLargeRequest || [], clientFilter),
    [commandLogLargeRequest, clientFilter]
  );

  const filteredCommandLogLargeReply = useMemo(
    () => filterByClient(commandLogLargeReply || [], clientFilter),
    [commandLogLargeReply, clientFilter]
  );

  const clearClientFilter = () => {
    searchParams.delete('client');
    setSearchParams(searchParams);
  };

  // Render a banner per missing capability so each retry targets the right
  // probe. A banner without a reason means the server genuinely doesn't expose
  // the capability (e.g. Redis lacks COMMANDLOG) — for that we only surface a
  // banner when BOTH are missing, so we never spam "COMMANDLOG not exposed"
  // on every Redis SlowLog page.
  const bothMissing = !hasSlowLog && !hasCommandLog;
  const showSlowLogBanner = !hasSlowLog && (Boolean(slowLogReason) || bothMissing);
  const showCommandLogBanner = !hasCommandLog && (Boolean(commandLogReason) || bothMissing);
  const FALLBACK_REASON = 'Not exposed by this server.';

  const content = (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Slow Log</h1>
        {clientFilter && (
          <div className="flex items-center gap-2 px-3 py-1 bg-muted rounded">
            <span className="text-sm">
              Filtered by: <span className="font-mono">{clientFilter}</span>
            </span>
            <button
              onClick={clearClientFilter}
              className="text-xs px-2 py-0.5 bg-destructive text-destructive-foreground rounded hover:bg-destructive/90"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {/* Time Filter */}
      <div className="flex items-center gap-4">
        <DateRangePicker
          value={dateRange}
          onChange={handleDateRangeChange}
        />
        {dateRange && (
          <span className="text-sm text-muted-foreground">
            Showing stored entries from {dateRange.from.toLocaleDateString()} to {dateRange.to.toLocaleDateString()}
          </span>
        )}
        {!dateRange && sortBy === 'magnitude' && (
          <span className="text-sm text-muted-foreground">
            Showing worst offenders from the full stored history
          </span>
        )}
      </div>

      {showSlowLogBanner && (
        <CapabilityStatusBanner
          key={`slowlog-${currentConnection?.id ?? 'none'}`}
          featureName="Slow Log"
          command="SLOWLOG"
          reason={slowLogReason?.reason ?? FALLBACK_REASON}
          onRetry={slowLogReason ? handleRetrySlowLog : undefined}
        />
      )}
      {showCommandLogBanner && (
        <CapabilityStatusBanner
          key={`commandlog-${currentConnection?.id ?? 'none'}`}
          featureName="Command Log"
          command="COMMANDLOG"
          reason={commandLogReason?.reason ?? FALLBACK_REASON}
          onRetry={commandLogReason ? handleRetryCommandLog : undefined}
        />
      )}

      {hasCommandLog ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
            <CardTitle>Command Log (Valkey)</CardTitle>
            <div className="flex gap-2">
              {viewMode === 'table' && (
                <>
                  <button
                    onClick={() => handleSortChange('recent')}
                    className={`px-3 py-1 text-sm rounded transition-colors ${
                      sortBy === 'recent'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted hover:bg-muted/80'
                    }`}
                  >
                    Recent
                  </button>
                  <button
                    onClick={() => handleSortChange('magnitude')}
                    title="Rank by duration from the full stored history - worst offenders first"
                    className={`px-3 py-1 text-sm rounded transition-colors ${
                      sortBy === 'magnitude'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted hover:bg-muted/80'
                    }`}
                  >
                    Worst offenders
                  </button>
                  <span className="w-px self-stretch bg-border mx-1" aria-hidden="true" />
                </>
              )}
              <button
                onClick={() => setViewMode('table')}
                className={`px-3 py-1 text-sm rounded transition-colors ${
                  viewMode === 'table'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted hover:bg-muted/80'
                }`}
              >
                Table
              </button>
              <button
                onClick={() => setViewMode('patterns')}
                className={`px-3 py-1 text-sm rounded transition-colors ${
                  viewMode === 'patterns'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted hover:bg-muted/80'
                }`}
              >
                Pattern Analysis
              </button>
            </div>
          </CardHeader>
          <CardContent>
            {activeTab === 'large-reply' && (
              <div className="mb-4 empty:hidden">
                <ScanSkewAdvisory report={scanSkewReport} />
              </div>
            )}
            {viewMode === 'patterns' && commandLogPatternAnalysis ? (
              <SlowLogPatternAnalysisView
                analysis={commandLogPatternAnalysis}
              />
            ) : (
              <CommandLogTable
                entries={{
                  slow: filteredCommandLogSlow,
                  'large-request': filteredCommandLogLargeRequest,
                  'large-reply': filteredCommandLogLargeReply,
                }}
                activeTab={activeTab}
                onTabChange={handleTabChange}
                pagination={useStoredData ? {
                  page,
                  pageSize: PAGE_SIZE,
                  hasMore: hasMoreEntries,
                  onPageChange: setPage,
                } : undefined}
              />
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
            <CardTitle>
              Slow Log ({capabilities?.dbType === 'valkey' ? 'Valkey' : 'Redis'})
            </CardTitle>
            <div className="flex gap-2">
              {viewMode === 'table' && (
                <>
                  <button
                    onClick={() => handleSortChange('recent')}
                    className={`px-3 py-1 text-sm rounded transition-colors ${
                      sortBy === 'recent'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted hover:bg-muted/80'
                    }`}
                  >
                    Recent
                  </button>
                  <button
                    onClick={() => handleSortChange('magnitude')}
                    title="Rank by duration from the full stored history - worst offenders first"
                    className={`px-3 py-1 text-sm rounded transition-colors ${
                      sortBy === 'magnitude'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted hover:bg-muted/80'
                    }`}
                  >
                    Worst offenders
                  </button>
                  <span className="w-px self-stretch bg-border mx-1" aria-hidden="true" />
                </>
              )}
              <button
                onClick={() => setViewMode('table')}
                className={`px-3 py-1 text-sm rounded transition-colors ${
                  viewMode === 'table'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted hover:bg-muted/80'
                }`}
              >
                Table
              </button>
              <button
                onClick={() => setViewMode('patterns')}
                className={`px-3 py-1 text-sm rounded transition-colors ${
                  viewMode === 'patterns'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted hover:bg-muted/80'
                }`}
              >
                Pattern Analysis
              </button>
            </div>
          </CardHeader>
          <CardContent>
            {viewMode === 'patterns' && slowLogPatternAnalysis ? (
              <SlowLogPatternAnalysisView analysis={slowLogPatternAnalysis} />
            ) : (
              <SlowLogTable entries={filteredSlowLog} />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );

  return content;
}
