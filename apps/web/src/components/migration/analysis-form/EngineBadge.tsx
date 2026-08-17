import type { Connection } from '../../../hooks/useConnection';
import { Badge } from '../../ui/badge';
import { cn } from '../../../lib/utils';

interface Props {
  capabilities: Connection['capabilities'];
  className?: string;
}

export function EngineBadge({ capabilities, className }: Props) {
  if (capabilities === undefined) {
    return (
      <Badge variant="outline" className={cn('text-muted-foreground', className)}>
        Version unknown
      </Badge>
    );
  }

  const isValkey = capabilities.dbType === 'valkey';
  const tone = isValkey
    ? 'border-primary/40 bg-primary/10 text-primary'
    : 'border-chart-info/40 bg-chart-info/10 text-chart-info';

  return (
    <Badge variant="outline" className={cn(tone, className)}>
      {isValkey ? 'Valkey' : 'Redis'} {capabilities.version}
    </Badge>
  );
}
