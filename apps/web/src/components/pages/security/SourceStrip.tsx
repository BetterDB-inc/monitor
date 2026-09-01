import type { CveSourceId, CveSourceStatus } from '@betterdb/shared';

interface SourceStripProps {
  sources: CveSourceStatus[];
  missingSources?: CveSourceId[];
  loading?: boolean;
  failed?: boolean;
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

function bannerText(sources: CveSourceStatus[], missingSources: CveSourceId[]): string | null {
  if (sources.length === 0) {
    return 'No advisory data has been fetched yet — nothing has been matched against this instance.';
  }

  const empty = sources.find((source) => {
    return source.state === 'empty';
  });

  if (empty) {
    return `${empty.source.toUpperCase()} returned 0 results for ${empty.query}, down from ${empty.previousRecordCount}. The findings on this page come from the last good fetch.`;
  }

  if (missingSources.length > 0) {
    const names = missingSources
      .map((source) => {
        return source.toUpperCase();
      })
      .join(', ');

    return `This scan ran without ${names}, so the findings on this page are incomplete.`;
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

  return 'border-chart-warning text-foreground';
}

export function SourceStrip({
  sources,
  missingSources = [],
  loading = false,
  failed = false,
}: SourceStripProps) {
  if (loading) {
    return (
      <div className="space-y-3 rounded-lg border p-4">
        <p data-testid="source-loading" className="text-muted-foreground text-sm">
          Checking advisory source health…
        </p>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="space-y-3 rounded-lg border p-4">
        <p
          data-testid="source-banner"
          className="border-destructive text-destructive rounded-md border p-3 text-sm"
        >
          Source health could not be loaded, so this page cannot say which feeds backed the scan.
          The findings themselves are unaffected.
        </p>
      </div>
    );
  }

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
                role="img"
                aria-label={`${source.source.toUpperCase()} ${STATE_LABEL[source.state]}`}
                className={`ring-foreground/20 inline-block size-2 rounded-full ring-1 ${DOT_CLASS[source.state]}`}
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
