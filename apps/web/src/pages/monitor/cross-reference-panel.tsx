import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BaselineWindow,
  CrossReferenceHotKey,
  CrossReferenceNewShape,
  CrossReferenceResult,
  CrossReferenceSlowlogRegression,
  monitorApi,
} from '../../api/monitor';

const BASELINE_OPTIONS: Array<{ value: BaselineWindow; label: string }> = [
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: 'same-hour-last-week', label: 'Same hour last week' },
];

interface Props {
  sessionId: string;
}

export function CrossReferencePanel({ sessionId }: Props) {
  const [baseline, setBaseline] = useState<BaselineWindow>('24h');

  const { data, error, isLoading, isFetching } = useQuery({
    queryKey: ['monitor', 'cross-reference', sessionId, baseline],
    queryFn: () => monitorApi.crossReference(sessionId, baseline),
    refetchOnWindowFocus: false,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Diffs this capture against the connection's recent history along four dimensions.
        </p>
        <div className="flex items-center gap-2">
          <label htmlFor="cross-baseline" className="text-xs text-muted-foreground">
            Baseline
          </label>
          <select
            id="cross-baseline"
            value={baseline}
            onChange={(e) => setBaseline(e.target.value as BaselineWindow)}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
          >
            {BASELINE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {isFetching && !isLoading && (
            <span className="text-xs text-muted-foreground">refreshing…</span>
          )}
        </div>
      </div>

      {isLoading && <p className="py-4 text-sm text-muted-foreground">Computing…</p>}
      {error && (
        <p className="text-sm text-destructive">
          Cross-reference failed: {(error as Error).message}
        </p>
      )}
      {data && <CrossReferenceSections result={data} />}
    </div>
  );
}

function CrossReferenceSections({ result }: { result: CrossReferenceResult }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Section
        title="New command shapes"
        subtitle={`${result.newShapes.length} not seen in baseline`}
      >
        <NewShapesList shapes={result.newShapes} />
      </Section>

      <Section
        title="Hot-key delta"
        subtitle={`${result.hotKeyDelta.newInTopK.length} new keys, ${result.hotKeyDelta.rankChanges.length} rank changes`}
      >
        <HotKeysList delta={result.hotKeyDelta} />
      </Section>

      <Section
        title="Slowlog regressions"
        subtitle={`${result.slowlogRegressions.length} verbs above baseline p95 rate`}
      >
        <RegressionsList regressions={result.slowlogRegressions} />
      </Section>

      <Section
        title="ACL / audit deltas"
        subtitle={`${result.aclDeltas.auditEntriesInWindow} audit-trail entries during the session window`}
      >
        <AclDeltas result={result} />
      </Section>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </div>
        <div className="text-[11px] text-muted-foreground">{subtitle}</div>
      </div>
      {children}
    </div>
  );
}

function NewShapesList({ shapes }: { shapes: CrossReferenceNewShape[] }) {
  if (shapes.length === 0) {
    return <Empty text="No new shapes — every captured command was seen in baseline." />;
  }
  return (
    <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
      {shapes.map((s) => (
        <li key={s.shape} className="flex items-center justify-between gap-2 font-mono">
          <span>
            {s.shape}
            {s.scriptSha && (
              <span className="ml-1 text-[10px] text-muted-foreground">script</span>
            )}
          </span>
          <span className="text-muted-foreground">×{s.countInCapture.toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}

function HotKeysList({ delta }: { delta: CrossReferenceResult['hotKeyDelta'] }) {
  if (delta.newInTopK.length === 0 && delta.rankChanges.length === 0) {
    return <Empty text="No hot-key shifts." />;
  }
  return (
    <div className="max-h-48 space-y-2 overflow-y-auto text-xs">
      {delta.newInTopK.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            New in top-K
          </div>
          <ul className="mt-1 space-y-1">
            {delta.newInTopK.map((k) => (
              <li key={k.key} className="flex items-center justify-between font-mono">
                <span>{k.key}</span>
                <span className="text-muted-foreground">
                  ×{k.countInCapture.toLocaleString()} (rank #{k.rankInCapture})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {delta.rankChanges.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Rank changes
          </div>
          <ul className="mt-1 space-y-1">
            {delta.rankChanges.map((k) => (
              <RankChangeRow key={k.key} k={k} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RankChangeRow({ k }: { k: CrossReferenceHotKey }) {
  const arrow =
    k.rankInBaseline !== null && k.rankInCapture < k.rankInBaseline
      ? '↑'
      : k.rankInBaseline !== null && k.rankInCapture > k.rankInBaseline
        ? '↓'
        : '·';
  return (
    <li className="flex items-center justify-between font-mono">
      <span>{k.key}</span>
      <span className="text-muted-foreground">
        #{k.rankInBaseline ?? '—'} {arrow} #{k.rankInCapture}
      </span>
    </li>
  );
}

function RegressionsList({ regressions }: { regressions: CrossReferenceSlowlogRegression[] }) {
  if (regressions.length === 0) {
    return (
      <Empty text="No slowlog regressions — no captured verbs exceed the baseline p95 slow rate." />
    );
  }
  return (
    <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
      {regressions.map((r) => (
        <li key={r.cmd} className="flex items-center justify-between font-mono">
          <span>{r.cmd}</span>
          <span className="text-muted-foreground">
            {r.observedRatePerSec.toFixed(2)}/s vs p95 {r.baselineP95RatePerSec.toFixed(2)}/s
          </span>
        </li>
      ))}
    </ul>
  );
}

function AclDeltas({ result }: { result: CrossReferenceResult }) {
  const counterDeltaUnknown =
    result.aclDeltas.counters.aclAccessDeniedAuthDelta === null &&
    result.aclDeltas.counters.rejectedConnectionsDelta === null;
  return (
    <dl className="space-y-1 text-xs">
      <Row label="Audit entries in window">{result.aclDeltas.auditEntriesInWindow}</Row>
      <Row label="acl_access_denied_auth Δ">
        {result.aclDeltas.counters.aclAccessDeniedAuthDelta ?? '—'}
      </Row>
      <Row label="rejected_connections Δ">
        {result.aclDeltas.counters.rejectedConnectionsDelta ?? '—'}
      </Row>
      {counterDeltaUnknown && (
        <p className="pt-1 text-[10px] text-muted-foreground">
          INFO counter deltas pending session-boundary snapshots (follow-up PR).
        </p>
      )}
    </dl>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono">{children}</dd>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-2 text-xs text-muted-foreground">{text}</p>;
}
