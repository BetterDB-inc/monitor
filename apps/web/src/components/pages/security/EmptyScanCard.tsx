import type { CveSourceStatus } from '@betterdb/shared';
import { GhsaTokenNotice } from './GhsaTokenNotice';
import { SourceDots } from './SourceDots';
import type { ScanCaveat } from './scan-completeness';

interface EmptyScanCardProps {
  engineLabel: string;
  caveats: ScanCaveat[];
  sources: CveSourceStatus[];
  advisoryCount: number;
  ghsaTokenMissing: boolean;
}

export function EmptyScanCard({
  engineLabel,
  caveats,
  sources,
  advisoryCount,
  ghsaTokenMissing,
}: EmptyScanCardProps) {
  const incomplete = caveats.length > 0;
  const answered = sources.filter((source) => {
    return source.state === 'ok';
  }).length;

  return (
    <section
      data-testid="empty-scan"
      className="flex flex-1 flex-col items-center justify-center gap-5 text-center"
    >
      {incomplete ? (
        <span className="border-chart-warning/45 bg-chart-warning/15 flex size-[72px] items-center justify-center rounded-full border">
          <svg
            width="34"
            height="34"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--chart-warning)"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
        </span>
      ) : (
        <span className="border-success/55 bg-success/20 flex size-[72px] items-center justify-center rounded-full border">
          <svg
            width="34"
            height="34"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--success-foreground)"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="M9 12l2 2 4-4" />
          </svg>
        </span>
      )}

      <div className="flex flex-col items-center gap-2">
        <h2 data-testid="verdict-headline" className="text-2xl font-semibold tracking-tight">
          {incomplete
            ? 'Nothing matched, but this scan is incomplete'
            : 'No known vulnerabilities found'}
        </h2>
        <p className="text-muted-foreground max-w-[560px] text-sm leading-[22px] text-pretty">
          {incomplete
            ? `${engineLabel} was checked against the ${answered} ${answered === 1 ? 'feed' : 'feeds'} that answered. Zero here is a floor, not an all-clear.`
            : `${engineLabel} was checked against all ${advisoryCount} advisories in the corpus. None of them apply to this instance or its loaded modules.`}
        </p>
      </div>

      {incomplete ? (
        <section
          data-testid="scan-caveats"
          role="status"
          aria-label="Scan completeness"
          className="border-chart-warning/55 bg-chart-warning/8 flex w-[620px] max-w-full flex-col gap-2.5 rounded-lg border p-4 text-left"
        >
          <ul className="space-y-2">
            {caveats.map((entry) => {
              return (
                <li
                  key={entry.id}
                  data-testid={`scan-caveat-${entry.id}`}
                  className="flex items-start gap-2.5 text-sm leading-[22px]"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--chart-warning)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="mt-[3px] shrink-0"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 8v4" />
                    <path d="M12 16h.01" />
                  </svg>
                  <span>{entry.text}</span>
                </li>
              );
            })}
          </ul>
          <div className="pl-[26px]">
            <GhsaTokenNotice show={ghsaTokenMissing} />
          </div>
        </section>
      ) : null}

      <div className="bg-card flex items-center gap-4 rounded-full border px-[18px] py-2.5">
        <SourceDots sources={sources} />
      </div>

      {incomplete ? null : (
        <p className="text-muted-foreground/75 text-xs leading-[18px]">
          All {sources.length} feeds answered. Version ranges resolve GitHub Advisories first; NVD
          ranges are branch-agnostic.
        </p>
      )}
    </section>
  );
}
