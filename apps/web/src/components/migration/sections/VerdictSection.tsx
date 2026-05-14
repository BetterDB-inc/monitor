import type { MigrationAnalysisResult, Incompatibility } from '@betterdb/shared';
import { CheckCircle, AlertTriangle, XCircle, Info } from 'lucide-react';

const SEVERITY_ORDER: Record<Incompatibility['severity'], number> = {
  blocking: 0,
  warning: 1,
  info: 2,
};

const SEVERITY_ICON_MAP: Record<Incompatibility['severity'], {
  icon: typeof XCircle;
  color: string;
}> = {
  blocking: { icon: XCircle, color: 'text-destructive' },
  warning: { icon: AlertTriangle, color: 'text-amber-600' },
  info: { icon: Info, color: 'text-primary' },
};

interface Props {
  job: MigrationAnalysisResult;
}

export function VerdictSection({ job }: Props) {
  if (job.incompatibilities === undefined) {
    return (
      <section className="bg-card border rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-2">Compatibility</h2>
        <p className="text-sm text-muted-foreground">Not available for this analysis.</p>
      </section>
    );
  }

  const blockingCount = job.blockingCount ?? 0;
  const warningCount = job.warningCount ?? 0;

  let bannerBg: string;
  let bannerText: string;
  let BannerIcon: typeof CheckCircle;
  let bannerMessage: string;

  if (blockingCount > 0) {
    bannerBg = 'bg-destructive/10 border-destructive/20';
    bannerText = 'text-destructive';
    BannerIcon = XCircle;
    bannerMessage = `${blockingCount} blocking issue(s) — resolve before migrating.`;
  } else if (warningCount > 0) {
    bannerBg = 'bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-800';
    bannerText = 'text-amber-800 dark:text-amber-400';
    BannerIcon = AlertTriangle;
    bannerMessage = `No blocking issues. ${warningCount} warning(s) to review.`;
  } else {
    bannerBg = 'bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800';
    bannerText = 'text-green-800 dark:text-green-400';
    BannerIcon = CheckCircle;
    bannerMessage = 'No compatibility issues found. Migration appears safe.';
  }

  const sorted = [...job.incompatibilities].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  return (
    <section className="space-y-4">
      <div className="bg-card border rounded-lg p-6 space-y-3">
        <h2 className="text-lg font-semibold">Compatibility</h2>
        <div className={`border rounded-lg px-4 py-3 flex items-start gap-3 ${bannerBg} ${bannerText}`}>
          <BannerIcon className="w-5 h-5 mt-0.5 flex-shrink-0" />
          <p className="font-medium">{bannerMessage}</p>
        </div>
      </div>

      {sorted.length > 0 && (
        <div className="space-y-2">
          {sorted.map((item, idx) => {
            const sev = SEVERITY_ICON_MAP[item.severity];
            const SevIcon = sev.icon;
            return (
              <div key={idx} className="bg-card border rounded-lg p-4 flex items-start gap-3">
                <SevIcon className={`w-5 h-5 mt-0.5 flex-shrink-0 ${sev.color}`} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{item.title}</span>
                    <span className="px-2 py-0.5 text-xs bg-muted text-muted-foreground rounded">
                      {item.category}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">{item.detail}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
