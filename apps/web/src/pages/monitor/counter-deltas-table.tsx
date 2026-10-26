import {
  CAPTURE_COUNTER_FIELDS,
  CAPTURE_COUNTER_LABELS,
  type CaptureCounterDeltas,
  type CaptureCounterName,
} from '@betterdb/shared';
import { formatBytes } from '../../lib/utils';

const BYTE_COUNTERS: ReadonlySet<CaptureCounterName> = new Set([
  'total_net_input_bytes',
  'total_net_output_bytes',
]);

function formatCounterValue(name: CaptureCounterName, value: number | null): string {
  if (value === null) {
    return '—';
  }
  return BYTE_COUNTERS.has(name) ? formatBytes(value) : value.toLocaleString();
}

function formatRate(value: number | null): string {
  return value === null ? '—' : value.toFixed(1);
}

function formatRatio(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function coverageText(d: CaptureCounterDeltas): string {
  if (d.coverage === 'unavailable') {
    return 'Not recorded for this capture — it predates session-boundary snapshots, or INFO was unreachable at start or end.';
  }
  const seconds = d.windowMs === null ? '—' : (d.windowMs / 1000).toFixed(1);
  const parts = [`Δ over ${seconds}s across ${d.nodesMeasured} node${d.nodesMeasured === 1 ? '' : 's'}`];
  if (d.nodesMeasured < d.nodesTotal) {
    parts.push(`${d.nodesTotal - d.nodesMeasured} of ${d.nodesTotal} nodes not measured`);
  }
  if (d.resets.length > 0) {
    parts.push(`counter reset on ${d.resets.map((r) => r.node).join(', ')} (excluded)`);
  }
  return parts.join(' · ');
}

interface Props {
  deltas: CaptureCounterDeltas;
  baseline?: CaptureCounterDeltas;
}

export function CounterDeltasTable({ deltas, baseline }: Props) {
  const nothingRecorded =
    deltas.coverage === 'unavailable' && (baseline === undefined || baseline.coverage === 'unavailable');
  if (nothingRecorded) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="counter-coverage">
        {coverageText(deltas)}
      </p>
    );
  }

  const rows = CAPTURE_COUNTER_FIELDS.filter((name) => {
    return deltas.deltas[name] !== null || (baseline !== undefined && baseline.deltas[name] !== null);
  });

  return (
    <div className="space-y-2 text-xs">
      <p className="text-[11px] text-muted-foreground" data-testid="counter-coverage">
        {coverageText(deltas)}
      </p>
      {baseline && (
        <p className="text-[11px] text-muted-foreground" data-testid="counter-baseline-coverage">
          Baseline capture: {coverageText(baseline)}
        </p>
      )}
      <table className="w-full">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="py-1 text-left font-medium">Counter</th>
            <th className="py-1 text-right font-medium">{baseline ? 'This capture' : 'Δ'}</th>
            {baseline && <th className="py-1 text-right font-medium">Baseline capture</th>}
          </tr>
        </thead>
        <tbody className="font-mono">
          <CounterRow
            label="Commands / sec"
            value={formatRate(deltas.derived.commandsPerSec)}
            baseline={baseline ? formatRate(baseline.derived.commandsPerSec) : undefined}
          />
          <CounterRow
            label="Keyspace hit ratio"
            value={formatRatio(deltas.derived.keyspaceHitRatio)}
            baseline={baseline ? formatRatio(baseline.derived.keyspaceHitRatio) : undefined}
          />
          {rows.map((name) => (
            <CounterRow
              key={name}
              label={CAPTURE_COUNTER_LABELS[name]}
              value={formatCounterValue(name, deltas.deltas[name])}
              baseline={baseline ? formatCounterValue(name, baseline.deltas[name]) : undefined}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CounterRow({ label, value, baseline }: { label: string; value: string; baseline?: string }) {
  return (
    <tr>
      <td className="py-0.5 pr-2 font-sans text-muted-foreground">{label}</td>
      <td className="py-0.5 text-right">{value}</td>
      {baseline !== undefined && <td className="py-0.5 text-right">{baseline}</td>}
    </tr>
  );
}
