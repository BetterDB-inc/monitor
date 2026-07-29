import { AlertTriangle, ShieldQuestion } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import type { ConfigHazardFinding } from '../../types/health';

/**
 * Standing advisory for hazardous static server configuration (valkey#3983:
 * default user disabled + AOF = silent data loss on reload). No dismissal —
 * the banner clears when the configuration is fixed and the next health poll
 * confirms it.
 */
export function ConfigHazardBanner({ hazards }: { hazards: ConfigHazardFinding[] | undefined }) {
  const active = (hazards ?? []).filter((h) => {
    return h.status === 'hazard' || h.status === 'unverified';
  });

  if (active.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {active.map((finding) => {
        const isConfirmed = finding.status === 'hazard';
        return (
          <Alert
            key={finding.id}
            className={isConfirmed ? 'border-yellow-500' : 'border-muted-foreground/40'}
          >
            {isConfirmed ? (
              <AlertTriangle className="w-4 h-4 text-yellow-500" />
            ) : (
              <ShieldQuestion className="w-4 h-4 text-muted-foreground" />
            )}
            <AlertTitle>
              {isConfirmed
                ? 'Hazardous server configuration'
                : 'Configuration could not be verified'}
            </AlertTitle>
            <AlertDescription>
              <p>{finding.message}</p>
            </AlertDescription>
          </Alert>
        );
      })}
    </div>
  );
}
