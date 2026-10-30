import {
  CAPTURE_COUNTER_FIELDS,
  CAPTURE_COUNTER_LABELS,
  type CaptureCounterDeltas,
  type CaptureCounterName,
} from '@betterdb/shared';
import { formatBytes } from '../../lib/utils';

const BYTE_COUNTERS: ReadonlySet<CaptureCounterName> = new Set(['total_net_input_bytes']);

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

function resetText(d: CaptureCounterDeltas): string | null {
  const restarted = d.resets.filter((r) => r.reason === 'restart').map((r) => r.node);
  const statsReset = d.resets.filter((r) => r.reason === 'counter_reset').map((r) => r.node);
  const parts: string[] = [];
  if (restarted.length > 0) {
    parts.push(`restarted: ${restarted.join(', ')}`);
  }
  if (statsReset.length > 0) {
    parts.push(`stats reset: ${statsReset.join(', ')}`);
  }
  return parts.length > 0 ? `${parts.join('; ')} (excluded)` : null;
}

function coverageText(d: CaptureCounterDeltas): string {
  if (d.coverage === 'unavailable') {
    if (d.pending === 'capture_running') {
      return 'Available when the capture ends, if INFO responded at start — the end sample is taken right after MONITOR stops.';
    }
    if (d.pending === 'capture_interrupted') {
      return 'Not recorded — the capture was interrupted (for example the API restarted) before its end sample was taken.';
    }
    const resets = resetText(d);
    if (resets !== null) {
      const allReset = d.resets.length >= d.nodesTotal;
      return allReset
        ? `Not measured — every sampled node restarted or reset its stats during the capture · ${resets}`
        : `Not measured — ${d.resets.length} of ${d.nodesTotal} nodes restarted or reset their stats and the rest have no complete sample · ${resets}`;
    }
    return 'Not recorded for this capture — it predates session-boundary snapshots, or INFO was unreachable at start or end.';
  }
  const seconds = d.windowMs === null ? '—' : (d.windowMs / 1000).toFixed(1);
  const parts = [`Δ over ${seconds}s across ${d.nodesMeasured} node${d.nodesMeasured === 1 ? '' : 's'}`];
  const unmeasured = d.nodesTotal - d.nodesMeasured - d.resets.length;
  if (unmeasured > 0) {
    parts.push(`${unmeasured} of ${d.nodesTotal} nodes not measured`);
  }
  const resets = resetText(d);
  if (resets !== null) {
    parts.push(resets);
  }
  if (d.incompleteCounters.length > 0) {
    const labels = d.incompleteCounters.map((name) => CAPTURE_COUNTER_LABELS[name]).join(', ');
    parts.push(`reported by only some nodes: ${labels}`);
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
    if (baseline === undefined) {
      return (
        <p className="text-xs text-muted-foreground" data-testid="counter-coverage">
          {coverageText(deltas)}
        </p>
      );
    }
    return (
      <div className="space-y-1 text-xs text-muted-foreground">
        <p data-testid="counter-coverage">This capture: {coverageText(deltas)}</p>
        <p data-testid="baseline-counter-coverage">Baseline: {coverageText(baseline)}</p>
      </div>
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
