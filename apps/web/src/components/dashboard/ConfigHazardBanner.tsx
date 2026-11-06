import { AlertTriangle, Info, ShieldQuestion } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import type { ConfigHazardFinding } from '../../types/health';

const STATUS_PRESENTATION: Record<
  ConfigHazardFinding['status'],
  { title: string; border: string; icon: typeof AlertTriangle; iconClass: string }
> = {
  hazard: {
    title: 'Hazardous server configuration',
    border: 'border-yellow-500',
    icon: AlertTriangle,
    iconClass: 'w-4 h-4 text-yellow-500',
  },
  unverified: {
    title: 'Configuration could not be verified',
    border: 'border-muted-foreground/40',
    icon: ShieldQuestion,
    iconClass: 'w-4 h-4 text-muted-foreground',
  },
  advisory: {
    title: 'Configuration advisory',
    border: 'border-muted-foreground/40',
    icon: Info,
    iconClass: 'w-4 h-4 text-muted-foreground',
  },
};

/**
 * Standing advisories for hazardous or risky static server configuration
 * (valkey#3983: default user disabled + AOF = silent data loss on reload;
 * valkey#3515: appendfsync=always blocking the main thread). No dismissal —
 * the banner clears when the configuration is fixed and the next health poll
 * confirms it.
 */
export function ConfigHazardBanner({
  hazards,
  unavailable,
}: {
  hazards: ConfigHazardFinding[] | undefined;
  unavailable?: boolean;
}) {
  const active = hazards ?? [];

  if (active.length === 0 && !unavailable) {
    return null;
  }

  return (
    <div className="space-y-2">
      {unavailable && (
        <Alert className="border-muted-foreground/40">
          <ShieldQuestion className="w-4 h-4 text-muted-foreground" />
          <AlertTitle>Config hazards could not be fully checked</AlertTitle>
          <AlertDescription>
            <p>Some configuration reads failed. Findings below may be incomplete.</p>
          </AlertDescription>
        </Alert>
      )}
      {active.map((finding) => {
        const presentation = STATUS_PRESENTATION[finding.status];
        const IconComponent = presentation.icon;
        return (
          <Alert key={finding.id} className={presentation.border}>
            <IconComponent className={presentation.iconClass} />
            <AlertTitle>{presentation.title}</AlertTitle>
            <AlertDescription>
              <p>{finding.message}</p>
            </AlertDescription>
          </Alert>
        );
      })}
    </div>
  );
}
