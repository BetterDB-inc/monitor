import { Line, LineChart, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PaymentRequiredError } from '@/api/client';
import type { ReplicaDivergenceHistory, ReplicationDivergenceLevel } from '@/types/anomaly';
import { formatBytes } from '@/lib/utils';
import { formatRelative } from '@/utils/connectionType';

const LEVEL_BADGE: Record<
  ReplicationDivergenceLevel,
  { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' }
> = {
  none: { label: 'In sync', variant: 'success' },
  behind: { label: 'Lagging', variant: 'secondary' },
  warning: { label: 'Diverging', variant: 'warning' },
  critical: { label: 'Critical', variant: 'destructive' },
  unobserved: { label: 'Not observed', variant: 'secondary' },
};

function formatBehind(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 1) return '<1s';
  return `${Math.round(seconds)}s`;
}

export function ReplicationDivergencePanel({
  replicas,
  error,
}: {
  replicas: ReplicaDivergenceHistory[] | undefined;
  error?: Error | null;
}) {
  if (error instanceof PaymentRequiredError) return null;
  const hasReplicas = !!replicas && replicas.length > 0;
  if (!hasReplicas && !error) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Replication divergence</CardTitle>
        <p className="text-sm text-muted-foreground">
          Offset gap per replica over the last hour, sampled per detection window
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            Replication history could not be loaded. This does not mean there are no replicas.
          </p>
        )}
        {hasReplicas && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Replica</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Gap</TableHead>
                <TableHead className="text-right">Behind</TableHead>
                <TableHead className="w-40">Trend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {replicas.map((r) => {
                const badge = LEVEL_BADGE[r.level] ?? LEVEL_BADGE.none;
                return (
                  <TableRow key={r.replica}>
                    <TableCell className="font-mono">{r.replica}</TableCell>
                    <TableCell>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.latest ? formatBytes(r.latest.gapBytes) : '—'}
                      {r.latest && (
                        <span className="block text-xs text-muted-foreground">
                          {formatRelative(r.latest.end)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatBehind(r.latest?.secondsBehind ?? null)}
                    </TableCell>
                    <TableCell>
                      {r.windows.length > 1 ? (
                        <div className="h-8 w-40" aria-label={`Gap trend for ${r.replica}`}>
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={r.windows}>
                              <Line
                                type="monotone"
                                dataKey="gapBytes"
                                stroke="currentColor"
                                strokeWidth={1.5}
                                dot={false}
                                isAnimationActive={false}
                              />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">collecting</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
