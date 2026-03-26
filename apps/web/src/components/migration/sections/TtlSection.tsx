import type { MigrationAnalysisResult } from '@betterdb/shared';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

interface Props {
  job: MigrationAnalysisResult;
}

export function TtlSection({ job }: Props) {
  const ttl = job.ttlDistribution;

  if (!ttl) {
    return (
      <section className="bg-card border rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-2">TTL Distribution</h2>
        <p className="text-sm text-muted-foreground">Not available for this analysis.</p>
      </section>
    );
  }

  const data = [
    { name: 'No Expiry', value: ttl.noExpiry, color: '#6b7280' },
    { name: '< 1 hour', value: ttl.expiresWithin1h, color: '#f59e0b' },
    { name: '< 24 hours', value: ttl.expiresWithin24h, color: '#3b82f6' },
    { name: '< 7 days', value: ttl.expiresWithin7d, color: '#10b981' },
    { name: '> 7 days', value: ttl.expiresAfter7d, color: '#8b5cf6' },
  ];

  return (
    <section className="bg-card border rounded-lg p-6">
      <h2 className="text-lg font-semibold mb-4">TTL Distribution</h2>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <XAxis dataKey="name" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip
              formatter={(value) => [`${Number(value).toLocaleString()} keys`, 'Count']}
            />
            <Bar dataKey="value">
              {data.map((entry, i) => <Cell key={i} fill={entry.color} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-muted-foreground mt-2">
        Sampled from {ttl.sampledKeyCount.toLocaleString()} keys.
      </p>
    </section>
  );
}
