import type { CveSourceId, CveSourceStatus } from '@betterdb/shared';

interface SourceStripProps {
  sources: CveSourceStatus[];
  missingSources?: CveSourceId[];
}

const DOT_CLASS: Record<CveSourceStatus['state'], string> = {
  ok: 'bg-success',
  quiet: 'bg-chart-warning',
  empty: 'bg-destructive',
};

function bannerText(sources: CveSourceStatus[], missingSources: CveSourceId[]): string | null {
  if (sources.length === 0) {
    return 'No advisory data has been fetched yet — nothing has been matched against this instance.';
  }

  const empty = sources.find((source) => {
    return source.state === 'empty';
  });

  if (empty) {
    return `${empty.source.toUpperCase()} returned 0 results for ${empty.query}, down from ${empty.previousRecordCount}. The findings below come from the last good fetch.`;
  }

  if (missingSources.length > 0) {
    const names = missingSources
      .map((source) => {
        return source.toUpperCase();
      })
      .join(', ');

    return `This scan ran without ${names}, so the findings below are incomplete.`;
  }

  const quiet = sources.find((source) => {
    return source.state === 'quiet';
  });

  if (quiet) {
    return `${quiet.source.toUpperCase()} could not be reached, so these findings may be incomplete.`;
  }

  return null;
}

function bannerClass(sources: CveSourceStatus[]): string {
  const broken =
    sources.length === 0 ||
    sources.some((source) => {
      return source.state === 'empty';
    });

  if (broken) {
    return 'border-destructive text-destructive';
  }

  return 'border-chart-warning text-chart-warning';
}

export function SourceStrip({ sources, missingSources = [] }: SourceStripProps) {
  const banner = bannerText(sources, missingSources);

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-4">
        {sources.map((source) => {
          return (
            <span key={source.source} className="flex items-center gap-2 text-sm">
              <span
                data-testid={`source-dot-${source.source}`}
                data-state={source.state}
                className={`inline-block size-2 rounded-full ${DOT_CLASS[source.state]}`}
              />
              <span className="text-muted-foreground">{source.source.toUpperCase()}</span>
            </span>
          );
        })}
      </div>
      {banner ? (
        <p
          data-testid="source-banner"
          className={`rounded-md border p-3 text-sm ${bannerClass(sources)}`}
        >
          {banner}
        </p>
      ) : null}
      <p className="text-muted-foreground text-xs">
        Version ranges resolve GitHub Advisories first; NVD ranges are branch-agnostic.
      </p>
    </div>
  );
}
