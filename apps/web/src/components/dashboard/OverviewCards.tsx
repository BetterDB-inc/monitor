import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import type { InfoResponse } from '../../types/metrics';

interface Props {
  info: InfoResponse | null;
}

export function OverviewCards({ info }: Props) {
  const totalHits = parseInt(info?.stats?.keyspace_hits ?? '0', 10);
  const totalMisses = parseInt(info?.stats?.keyspace_misses ?? '0', 10);
  const hitRate = totalHits + totalMisses > 0 ? ((totalHits / (totalHits + totalMisses)) * 100).toFixed(1) : '0.0';

  const cards = [
    {
      title: 'Operations/sec',
      value: info?.stats?.instantaneous_ops_per_sec ?? '-',
      subtitle: `${parseInt(info?.stats?.total_commands_processed ?? '0', 10).toLocaleString()} total`,
    },
    {
      title: 'Connected Clients',
      value: info?.clients?.connected_clients ?? '-',
      subtitle: `${info?.clients?.blocked_clients ?? '0'} blocked`,
    },
    {
      title: 'Memory Used',
      value: info?.memory?.used_memory_human ?? '-',
      subtitle: `Peak: ${info?.memory?.used_memory_peak_human ?? '-'}`,
    },
    {
      title: 'Hit Rate',
      value: `${hitRate}%`,
      subtitle: `${totalHits.toLocaleString()} hits`,
    },
    {
      title: 'Evicted Keys',
      value: parseInt(info?.stats?.evicted_keys ?? '0', 10).toLocaleString(),
      subtitle: `${parseInt(info?.stats?.expired_keys ?? '0', 10).toLocaleString()} expired`,
    },
    {
      title: 'Uptime',
      value: info?.server ? `${info.server.uptime_in_days}d` : '-',
      subtitle: info?.server ? `${Math.floor(parseInt(info.server.uptime_in_seconds, 10) / 3600) % 24}h` : '',
    },
  ];

  return (
    <>
      {cards.map((card) => (
        <Card key={card.title} className="min-w-[180px] flex-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {card.title}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{card.value}</div>
            <p className="text-xs text-muted-foreground">{card.subtitle}</p>
          </CardContent>
        </Card>
      ))}
    </>
  );
}
