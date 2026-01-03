import { useState } from 'react';
import { metricsApi } from '../api/metrics';
import { usePolling } from '../hooks/usePolling';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import type { StoredAclEntry, AuditStats } from '../types/metrics';

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
  const [selectedUser, setSelectedUser] = useState<string>('');

  const { data: stats } = usePolling({
    fetcher: () => metricsApi.getAuditStats(),
    interval: 30000, // 30 seconds
  });

  const { data: entries } = usePolling({
    fetcher: () => metricsApi.getAuditEntries({ limit: 100 }),
    interval: 10000, // 10 seconds
  });

  const { data: failedAuth } = usePolling({
    fetcher: () => metricsApi.getAuditFailedAuth(undefined, undefined, 50),
    interval: 10000,
  });

  const filteredEntries = selectedUser && entries
    ? entries.filter(e => e.username === selectedUser)
    : entries;

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Audit Trail</h1>

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

      {/* Failed Authentication */}
      {failedAuth && failedAuth.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">Recent Failed Authentication</CardTitle>
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
                  {failedAuth.slice(0, 10).map((entry) => (
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
          {stats && Object.keys(stats.entriesByUser).length > 0 && (
            <div className="mt-2">
              <select
                className="border rounded px-2 py-1 text-sm"
                value={selectedUser}
                onChange={(e) => setSelectedUser(e.target.value)}
              >
                <option value="">All Users</option>
                {Object.keys(stats.entriesByUser).map((user) => (
                  <option key={user} value={user}>
                    {user} ({stats.entriesByUser[user]})
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
                            entry.reason.includes('auth')
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
}
