import type { SampleValidationResult, SampleKeyStatus } from '@betterdb/shared';
import { InfoTip } from './InfoTip';

interface Props {
  sample?: SampleValidationResult;
}

function StatusBadge({ status }: { status: SampleKeyStatus }) {
  switch (status) {
    case 'missing':
      return <span className="px-1.5 py-0.5 rounded text-xs bg-red-100 text-red-800">missing</span>;
    case 'type_mismatch':
      return <span className="px-1.5 py-0.5 rounded text-xs bg-red-100 text-red-800">type mismatch</span>;
    case 'value_mismatch':
      return <span className="px-1.5 py-0.5 rounded text-xs bg-amber-100 text-amber-800">value mismatch</span>;
    default:
      return <span className="px-1.5 py-0.5 rounded text-xs bg-green-100 text-green-800">match</span>;
  }
}

export function SampleValidationSection({ sample }: Props) {
  if (!sample) {
    return <p className="text-sm text-muted-foreground">Not available.</p>;
  }

  const allMatch = sample.missing === 0 && sample.typeMismatches === 0 && sample.valueMismatches === 0;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">Sample Validation</h3>

      <div className="flex flex-wrap gap-4 text-sm">
        <span>
          <span className="font-mono font-medium">{sample.matched}</span>
          <span className="text-muted-foreground">
            /{sample.sampledKeys} matched
            <InfoTip text="500 randomly sampled keys were compared by type and value between source and target." />
          </span>
        </span>
        {sample.missing > 0 && (
          <span className="text-destructive">{sample.missing} missing</span>
        )}
        {sample.typeMismatches > 0 && (
          <span className="text-destructive">{sample.typeMismatches} type mismatch{sample.typeMismatches !== 1 ? 'es' : ''}</span>
        )}
        {sample.valueMismatches > 0 && (
          <span className="text-amber-700">{sample.valueMismatches} value mismatch{sample.valueMismatches !== 1 ? 'es' : ''}</span>
        )}
      </div>

      {allMatch && (
        <p className="text-sm text-green-700">All sampled keys validated successfully.</p>
      )}

      {/* Risk #1: timing gap note */}
      <p className="text-xs text-muted-foreground">
        Some mismatches may reflect keys written to source after migration scanning began.
      </p>

      {sample.issues.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-1 font-medium">Key</th>
                <th className="pb-1 font-medium">Type</th>
                <th className="pb-1 font-medium">Status</th>
                <th className="pb-1 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {sample.issues.map((issue, idx) => (
                <tr key={idx} className="border-b last:border-0">
                  <td className="py-1 font-mono truncate max-w-[200px]" title={issue.key}>{issue.key}</td>
                  <td className="py-1 font-mono">{issue.type}</td>
                  <td className="py-1"><StatusBadge status={issue.status} /></td>
                  <td className="py-1 text-muted-foreground">{issue.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
