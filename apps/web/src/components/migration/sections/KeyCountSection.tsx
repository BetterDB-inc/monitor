import type { KeyCountComparison } from '@betterdb/shared';
import { InfoTip } from './InfoTip';

interface Props {
  keyCount?: KeyCountComparison;
}

export function KeyCountSection({ keyCount }: Props) {
  if (!keyCount) {
    return <p className="text-sm text-muted-foreground">Not available.</p>;
  }

  const { sourceKeys, targetKeys, discrepancy, discrepancyPercent, warning, typeBreakdown } = keyCount;

  const discrepancyColor =
    discrepancyPercent <= 1
      ? 'text-green-700'
      : discrepancyPercent <= 5
        ? 'text-amber-700'
        : 'text-destructive';

  const sign = discrepancy >= 0 ? '+' : '';

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">Key Count Comparison</h3>

      <div className="grid grid-cols-3 gap-4 text-sm">
        <div>
          <span className="text-muted-foreground">Source</span>
          <p className="font-mono font-medium">{sourceKeys.toLocaleString()}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Target</span>
          <p className="font-mono font-medium">{targetKeys.toLocaleString()}</p>
        </div>
        <div>
          <span className="text-muted-foreground">
            Discrepancy
            <InfoTip text="A positive discrepancy means the target has more keys than the source. This is expected if the target already contained data before migration." />
          </span>
          <p className={`font-mono font-medium ${discrepancyColor}`}>
            {sign}{discrepancy.toLocaleString()} ({discrepancyPercent}%)
          </p>
        </div>
      </div>

      {warning && (
        <p className="text-sm text-amber-600">{warning}</p>
      )}

      {typeBreakdown && typeBreakdown.length > 0 && (
        <div className="mt-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-1 font-medium">Type</th>
                <th className="pb-1 font-medium">Source (est.)</th>
                <th className="pb-1 font-medium">Target (est.)</th>
              </tr>
            </thead>
            <tbody>
              {typeBreakdown.map((row) => (
                <tr key={row.type} className="border-b last:border-0">
                  <td className="py-1 font-mono">{row.type}</td>
                  <td className="py-1 font-mono">{row.sourceEstimate.toLocaleString()}</td>
                  <td className="py-1 font-mono">{row.targetEstimate.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-muted-foreground mt-1">
            Type counts are estimated from Phase 1 analysis.
          </p>
        </div>
      )}
    </div>
  );
}
