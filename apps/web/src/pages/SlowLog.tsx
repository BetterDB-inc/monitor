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
import { DateRangePicker, DateRange } from '../components/ui/date-range-picker';
import { UnavailableOverlay } from '../components/UnavailableOverlay';
import type { CommandLogType } from '../types/metrics';

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
  const { hasCommandLog, hasSlowLog, capabilities } = useCapabilities();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = getTabFromParams(searchParams);
  const clientFilter = searchParams.get('client');
  const [viewMode, setViewMode] = useState<'table' | 'patterns'>('table');

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

  // === SLOW LOG (non-Valkey or Redis) ===
  // Live polling (no time filter)
  const { data: liveSlowLog } = usePolling({
    fetcher: () => metricsApi.getSlowLog(100, true),
    interval: 10000,
    enabled: !hasCommandLog && !isTimeFiltered,
    refetchKey: currentConnection?.id,
  });

  // Stored slow log (with time filter)
  const { data: storedSlowLog } = useStoredSlowLog({
    connectionId: currentConnection?.id,
    startTime,
    endTime,
    enabled: isTimeFiltered && !hasCommandLog,
  });

  // Use stored data when filtered, live data otherwise
  const slowLog = isTimeFiltered ? storedSlowLog : liveSlowLog;

  // === COMMAND LOG (Valkey-specific) ===
  // Live polling (no time filter)
  const { data: liveCommandLogSlow } = usePolling({
    fetcher: () => metricsApi.getCommandLog(100, 'slow'),
    interval: 10000,
    enabled: hasCommandLog && activeTab === 'slow' && !isTimeFiltered,
    refetchKey: currentConnection?.id,
  });

  const { data: liveCommandLogLargeRequest } = usePolling({
    fetcher: () => metricsApi.getCommandLog(100, 'large-request'),
    interval: 10000,
    enabled: hasCommandLog && activeTab === 'large-request' && !isTimeFiltered,
    refetchKey: currentConnection?.id,
  });

  const { data: liveCommandLogLargeReply } = usePolling({
    fetcher: () => metricsApi.getCommandLog(100, 'large-reply'),
    interval: 10000,
    enabled: hasCommandLog && activeTab === 'large-reply' && !isTimeFiltered,
    refetchKey: currentConnection?.id,
  });

  // Stored command log (with time filter and pagination)
  const { data: storedCommandLogResult } = useStoredCommandLog({
    connectionId: currentConnection?.id,
    startTime,
    endTime,
    activeTab,
    page,
    enabled: isTimeFiltered && hasCommandLog,
  });
  const storedCommandLogEntries = storedCommandLogResult?.entries ?? null;
  const hasMoreEntries = storedCommandLogResult?.hasMore ?? false;

  // Use stored data when filtered, live data otherwise
  const commandLogSlow = isTimeFiltered ? (activeTab === 'slow' ? storedCommandLogEntries : null) : liveCommandLogSlow;
  const commandLogLargeRequest = isTimeFiltered ? (activeTab === 'large-request' ? storedCommandLogEntries : null) : liveCommandLogLargeRequest;
  const commandLogLargeReply = isTimeFiltered ? (activeTab === 'large-reply' ? storedCommandLogEntries : null) : liveCommandLogLargeReply;

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

  const slowLogUnavailable = !hasSlowLog && !hasCommandLog;
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
      </div>

      {hasCommandLog ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
            <CardTitle>Command Log (Valkey)</CardTitle>
            <div className="flex gap-2">
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
                pagination={isTimeFiltered ? {
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

  if (slowLogUnavailable) {
    return (
      <UnavailableOverlay featureName="Slow Log" command="SLOWLOG/COMMANDLOG">
        {content}
      </UnavailableOverlay>
    );
  }

  return content;
}
