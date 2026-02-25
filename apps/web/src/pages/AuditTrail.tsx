import { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { metricsApi } from '../api/metrics';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { useCapabilities } from '../hooks/useCapabilities';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { UnavailableOverlay } from '../components/UnavailableOverlay';

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

function formatRelativeTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function AuditTrail() {
  const { currentConnection } = useConnection();
  const { hasAclLog } = useCapabilities();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedUser, setSelectedUser] = useState<string>('');
  const ipFilter = searchParams.get('ip');

  useEffect(() => {
    const user = searchParams.get('user');
    if (user) {
      setSelectedUser(user);
    }
  }, [searchParams]);

  const clearIpFilter = () => {
    searchParams.delete('ip');
    setSearchParams(searchParams);
  };

  const { data: stats } = usePolling({
    fetcher: () => metricsApi.getAuditStats(),
    interval: 30000, // 30 seconds
    refetchKey: currentConnection?.id,
  });

  const { data: entries } = usePolling({
    fetcher: () => metricsApi.getAuditEntries({ limit: 100 }),
    interval: 10000, // 10 seconds
    refetchKey: currentConnection?.id,
  });

  const { data: failedAuth } = usePolling({
    fetcher: () => metricsApi.getAuditFailedAuth(undefined, undefined, 50),
    interval: 10000,
    refetchKey: currentConnection?.id,
  });

  const filteredEntries = useMemo(() => {
    let result = entries || [];
    if (selectedUser) {
      result = result.filter(e => e.username === selectedUser);
    }
    if (ipFilter) {
      result = result.filter(e => e.sourceHost?.includes(ipFilter) || e.clientInfo?.includes(ipFilter));
    }
    return result;
  }, [entries, selectedUser, ipFilter]);

  const filteredFailedAuth = useMemo(() => {
    if (!failedAuth || !ipFilter) return failedAuth;
    return failedAuth.filter(e => e.clientInfo?.includes(ipFilter));
  }, [failedAuth, ipFilter]);

  const userOptions = useMemo(() => {
    const usersFromStats = stats?.entriesByUser ?? {};
    const usersFromEntries = new Set(entries?.map(e => e.username) ?? []);
    const allUsers = new Set([...Object.keys(usersFromStats), ...usersFromEntries]);
    return Array.from(allUsers).sort().map(user => ({
      user,
      count: usersFromStats[user],
    }));
  }, [stats?.entriesByUser, entries]);

  const content = (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Audit Trail</h1>
        {ipFilter && (
          <div className="flex items-center gap-2 px-3 py-1 bg-muted rounded">
            <span className="text-sm">
              Filtered by IP: <span className="font-mono">{ipFilter}</span>
            </span>
            <button
              onClick={clearIpFilter}
              className="text-xs px-2 py-0.5 bg-destructive text-destructive-foreground rounded hover:bg-destructive/90"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Total Entries</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{stats?.totalEntries ?? 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Unique Users</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{stats?.uniqueUsers ?? 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Time Range</CardTitle>
          </CardHeader>
          <CardContent>
            {stats?.timeRange ? (
              <div className="text-sm">
                <div>From: {formatTimestamp(stats.timeRange.earliest)}</div>
                <div>To: {formatTimestamp(stats.timeRange.latest)}</div>
              </div>
            ) : (
              <div className="text-muted-foreground">No data yet</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Entries by Reason */}
      {stats && Object.keys(stats.entriesByReason).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Entries by Reason</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {Object.entries(stats.entriesByReason).map(([reason, count]) => (
                <div key={reason} className="text-center">
                  <div className="text-2xl font-bold">{count}</div>
                  <div className="text-sm text-muted-foreground">{reason}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Authentication Events */}
      {filteredFailedAuth && filteredFailedAuth.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              Recent Authentication Events
              {ipFilter && <span className="text-sm font-normal text-muted-foreground ml-2">({filteredFailedAuth.length} from {ipFilter})</span>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-2">Time</th>
                    <th className="text-left p-2">User</th>
                    <th className="text-left p-2">Reason</th>
                    <th className="text-left p-2">Object</th>
                    <th className="text-left p-2">Client</th>
                    <th className="text-left p-2">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFailedAuth.slice(0, 10).map((entry) => (
                    <tr key={entry.id} className="border-b hover:bg-muted">
                      <td className="p-2">{formatTimestamp(entry.capturedAt)}</td>
                      <td className="p-2 font-mono">{entry.username}</td>
                      <td className="p-2">{entry.reason}</td>
                      <td className="p-2 font-mono text-xs">{entry.object}</td>
                      <td className="p-2 font-mono text-xs">{entry.clientInfo}</td>
                      <td className="p-2">{entry.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* All Entries */}
      <Card>
        <CardHeader>
          <CardTitle>All Audit Entries</CardTitle>
          {userOptions.length > 0 && (
            <div className="mt-2">
              <select
                className="border rounded px-2 py-1 text-sm"
                value={selectedUser}
                onChange={(e) => setSelectedUser(e.target.value)}
              >
                <option value="">All Users</option>
                {userOptions.map(({ user, count }) => (
                  <option key={user} value={user}>
                    {user}{count !== undefined ? ` (${count})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
        </CardHeader>
        <CardContent>
          {filteredEntries && filteredEntries.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-2">Captured</th>
                    <th className="text-left p-2">User</th>
                    <th className="text-left p-2">Reason</th>
                    <th className="text-left p-2">Context</th>
                    <th className="text-left p-2">Object</th>
                    <th className="text-left p-2">Client</th>
                    <th className="text-left p-2">Source</th>
                    <th className="text-left p-2">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEntries.map((entry) => (
                    <tr key={entry.id} className="border-b hover:bg-muted">
                      <td className="p-2">
                        <div>{formatTimestamp(entry.capturedAt)}</div>
                        <div className="text-xs text-muted-foreground">
                          {formatRelativeTime(entry.ageSeconds)}
                        </div>
                      </td>
                      <td className="p-2 font-mono">{entry.username}</td>
                      <td className="p-2">
                        <span
                          className={`px-2 py-1 rounded text-xs ${
                            entry.reason === 'auth'
                              ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                              : entry.reason === 'command'
                              ? 'bg-destructive/10 text-destructive'
                              : 'bg-muted'
                          }`}
                        >
                          {entry.reason}
                        </span>
                      </td>
                      <td className="p-2 font-mono text-xs">{entry.context}</td>
                      <td className="p-2 font-mono text-xs">{entry.object}</td>
                      <td className="p-2 font-mono text-xs">{entry.clientInfo}</td>
                      <td className="p-2 font-mono text-xs">
                        {entry.sourceHost}:{entry.sourcePort}
                      </td>
                      <td className="p-2">{entry.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No audit entries found. The audit trail will populate as ACL events occur.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );

  if (!hasAclLog) {
    return (
      <UnavailableOverlay featureName="Audit Trail" command="ACL LOG">
        {content}
      </UnavailableOverlay>
    );
  }

  return content;
}
