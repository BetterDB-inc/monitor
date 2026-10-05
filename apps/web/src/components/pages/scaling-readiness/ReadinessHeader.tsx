import { READINESS_DIMENSION_LABELS, type ScalingReadiness } from '@betterdb/shared';
import { Card, CardContent } from '../../ui/card';
import { BAND_STYLES } from './band';

export function ReadinessHeader({ readiness }: { readiness: ScalingReadiness }) {
  const band = readiness.band ? BAND_STYLES[readiness.band] : null;
  const available = readiness.dimensions.filter((d) => d.excludedReason === null).length;
  const capped = readiness.cappedBy
    ? readiness.dimensions.find((d) => d.key === readiness.cappedBy)
    : undefined;
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-6 pt-6">
        {readiness.score !== null && band ? (
          <>
            <span className={`text-5xl font-bold ${band.text}`}>{readiness.score}</span>
            <span className={`rounded px-2 py-0.5 text-sm font-medium ${band.badge}`}>{band.label}</span>
          </>
        ) : null}
        <div className="space-y-1">
          <p className="text-base">{readiness.summary}</p>
          {capped && readiness.cappedBy ? (
            <p className="text-sm text-muted-foreground">
              {`Capped by ${READINESS_DIMENSION_LABELS[readiness.cappedBy]} (${capped.score})`}
            </p>
          ) : null}
          {readiness.score !== null && available < 5 ? (
            <p className="text-sm text-muted-foreground">{`Based on ${available} of 5 dimensions`}</p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
