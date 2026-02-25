import { Badge } from '../ui/badge';
import { useCapabilities } from '../../hooks/useCapabilities';

export function CapabilitiesBadges() {
  const { capabilities, runtime, isValkey, hasCommandLog, hasClusterSlotStats } = useCapabilities();

  if (!capabilities) return null;

  const hasAnyRestriction = runtime && Object.values(runtime).some(v => v === false);

  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant={isValkey ? 'default' : 'secondary'}>
        {capabilities.dbType} {capabilities.version}
      </Badge>
      {hasCommandLog && <Badge variant="outline">COMMANDLOG</Badge>}
      {hasClusterSlotStats && <Badge variant="outline">SLOT-STATS</Badge>}
      {hasAnyRestriction && (
        <Badge variant="outline" className="border-yellow-500 text-yellow-600">
          Managed (restricted)
        </Badge>
      )}
    </div>
  );
}
