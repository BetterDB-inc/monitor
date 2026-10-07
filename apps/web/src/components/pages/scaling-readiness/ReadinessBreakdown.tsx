import { READINESS_DIMENSION_LABELS, type ReadinessDimension } from '@betterdb/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { BAND_STYLES, headroomBand } from './band';

export function ReadinessBreakdown({ dimensions }: { dimensions: ReadinessDimension[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Breakdown</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {dimensions.map((d) => {
          const excluded = d.excludedReason !== null;
          return (
            <div
              key={d.key}
              data-dimension={d.key}
              data-excluded={excluded ? 'true' : 'false'}
              className={`grid grid-cols-[10rem_1fr_4rem_5rem] items-center gap-4 ${excluded ? 'opacity-50' : ''}`}
            >
              <span className="font-medium">{READINESS_DIMENSION_LABELS[d.key]}</span>
              <div className="space-y-1">
                <div className="h-2 w-full rounded bg-muted">
                  {d.score !== null ? (
                    <div
                      className={`h-2 rounded ${BAND_STYLES[headroomBand(d.score)].bar}`}
                      style={{ width: `${d.score}%` }}
                    />
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">{excluded ? d.excludedReason : d.detail}</p>
              </div>
              <span className="text-sm text-muted-foreground">{`${d.weight}%`}</span>
              <span className="text-sm">{d.contribution !== null ? `${d.contribution} pts` : '—'}</span>
            </div>
          );
        })}
        <p className="pt-2 text-xs text-muted-foreground">
          Weights are renormalized over the dimensions with data. The score never exceeds the
          weakest dimension by more than 15 points.
        </p>
      </CardContent>
    </Card>
  );
}
