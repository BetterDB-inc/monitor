import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Skeleton } from '../ui/skeleton';
import type { HealthResponse } from '../../types/metrics';
import type { Connection } from '../../hooks/useConnection';
import { ConnectionTypeBadge } from '../connection-selector/ConnectionTypeBadge';

interface Props {
  health: HealthResponse | null;
  loading: boolean;
  connection?: Connection | null;
}

export function ConnectionCard({ health, loading, connection }: Props) {
  if (loading) {
    return (
      <Card className="min-w-[180px] flex-1">
        <CardHeader>
          <CardTitle>Connection</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-4 w-24" />
        </CardContent>
      </Card>
    );
  }

  const statusVariant = health?.status === 'connected' ? 'default' : 'destructive';

  return (
    <Card className="min-w-[180px] flex-1">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">Connection</CardTitle>
        <Badge variant={statusVariant}>{health?.status ?? 'Unknown'}</Badge>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">
          {health?.database.type === 'valkey' ? 'Valkey' : 'Redis'} {health?.database.version}
        </div>
        <p className="flex flex-wrap items-center gap-y-1 text-xs text-muted-foreground">
          {health?.database.host}:{health?.database.port}
          {connection ? <ConnectionTypeBadge connection={connection} /> : null}
        </p>
      </CardContent>
    </Card>
  );
}
