import type { MigrationAnalysisResult } from '@betterdb/shared';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';

const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-warning)', 'var(--destructive)', 'var(--chart-3)', 'var(--chart-info)', 'var(--muted-foreground)'];
const TYPE_NAMES = ['string', 'hash', 'list', 'set', 'zset', 'stream', 'other'] as const;

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

interface Props {
  job: MigrationAnalysisResult;
}

export function DataTypeSection({ job }: Props) {
  const breakdown = job.dataTypeBreakdown;

  if (!breakdown) {
    return (
      <section className="bg-card border rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-2">Data Types</h2>
        <p className="text-sm text-muted-foreground">Not available for this analysis.</p>
      </section>
    );
  }

  const chartData = TYPE_NAMES
    .map(name => ({ name, count: breakdown[name]?.count ?? 0 }))
    .filter(d => d.count > 0);

  return (
    <section className="bg-card border rounded-lg p-6">
      <h2 className="text-lg font-semibold mb-4">Data Types</h2>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={chartData} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
                {chartData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="pb-2">Type</th>
                <th className="pb-2">Key Count</th>
                <th className="pb-2">Sampled Memory</th>
                <th className="pb-2">
                  Est. Total Memory
                </th>
              </tr>
            </thead>
            <tbody>
              {TYPE_NAMES.map(name => {
                const dt = breakdown[name];
                if (!dt || dt.count === 0) return null;
                return (
                  <tr key={name} className="border-b">
                    <td className="py-2 font-medium capitalize">{name}</td>
                    <td className="py-2">{dt.count.toLocaleString()}</td>
                    <td className="py-2">{formatBytes(dt.sampledMemoryBytes)}</td>
                    <td className="py-2">~{formatBytes(dt.estimatedTotalMemoryBytes)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
