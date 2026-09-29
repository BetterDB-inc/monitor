import { useState } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import type { DiscoveredInstance } from '@betterdb/shared';
import { cn } from '@/lib/utils';
import { formatTimeAgo } from '@/lib/formatters';

interface DiscoveredInstancesSectionProps {
  instances: DiscoveredInstance[];
  onRegister: (instance: DiscoveredInstance) => void;
  onDismiss: (instance: DiscoveredInstance) => void;
  error?: string | null;
}

function systemLabel(instance: DiscoveredInstance): string | null {
  if (!instance.dbSystem) return null;
  const name = instance.dbSystem === 'valkey' ? 'Valkey' : 'Redis';
  return instance.version ? `${name} ${instance.version}` : name;
}

export function DiscoveredInstancesSection({ instances, onRegister, onDismiss, error }: DiscoveredInstancesSectionProps) {
  const [expanded, setExpanded] = useState(false);
  if (instances.length === 0) return null;

  return (
    <div className="border-t p-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="w-full flex items-center justify-between rounded-sm px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
      >
        <span>{instances.length} discovered via OTLP</span>
        <ChevronDownIcon className={cn('w-3 h-3 transition-transform', expanded && 'rotate-180')} />
      </button>
      {error ? (
        <p role="alert" className="px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {expanded ? (
        <ul className="max-h-48 overflow-y-auto">
          {instances.map((instance) => {
            const label = systemLabel(instance);
            return (
              <li key={`${instance.host}:${instance.port}`} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                <div className="min-w-0 flex-1">
                  <span className="block truncate">{instance.suggestedName}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {instance.host}:{instance.port}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {label ? <span>{label}</span> : null}
                    {label ? ' · ' : null}
                    last seen {formatTimeAgo(instance.lastSeenAt)}
                  </span>
                </div>
                <button
                  type="button"
                  aria-label={`Register ${instance.suggestedName}`}
                  onClick={() => onRegister(instance)}
                  className="text-xs text-primary hover:underline"
                >
                  Register
                </button>
                <button
                  type="button"
                  aria-label={`Dismiss ${instance.suggestedName}`}
                  onClick={() => onDismiss(instance)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Dismiss
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
