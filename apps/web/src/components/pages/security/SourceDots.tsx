import type { CveSourceStatus } from '@betterdb/shared';

interface SourceDotsProps {
  sources: CveSourceStatus[];
}

const DOT_CLASS: Record<CveSourceStatus['state'], string> = {
  ok: 'bg-success dark:bg-success-foreground',
  quiet: 'bg-chart-warning',
  empty: 'bg-destructive',
};

const STATE_LABEL: Record<CveSourceStatus['state'], string> = {
  ok: 'healthy',
  quiet: 'unreachable',
  empty: 'returned nothing',
};

export function SourceDots({ sources }: SourceDotsProps) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      {sources.map((source) => {
        return (
          <span key={source.source} className="flex items-center gap-2 text-sm">
            <span
              data-testid={`source-dot-${source.source}`}
              data-state={source.state}
              role="img"
              aria-label={`${source.source.toUpperCase()} ${STATE_LABEL[source.state]}`}
              className={`ring-foreground/20 inline-block size-2 rounded-full ring-1 ${DOT_CLASS[source.state]}`}
            />
            <span className="text-muted-foreground">{source.source.toUpperCase()}</span>
          </span>
        );
      })}
    </div>
  );
}
