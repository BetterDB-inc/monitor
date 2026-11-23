import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { incidentEventPath } from '@betterdb/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button';
import { metricsApi } from '@/api/metrics';
import type { TopologyDivergenceDetail, TopologyDivergenceReport } from '@/types/metrics';

function divergenceKey(detail: TopologyDivergenceDetail): string {
  const sides = detail.sides
    .map((side) => side.nodes.map((n) => n.nodeId).sort().join(','))
    .join('|');
  const kinds = detail.disagreements
    .map((d) => `${d.kind}:${d.subject.map((s) => s.nodeId).sort().join(',')}`)
    .sort()
    .join(';');
  return `${detail.since}:${sides}:${kinds}`;
}

function formatDivergenceSummary(detail: TopologyDivergenceDetail): string {
  const left = detail.sides[0]?.nodes.map((n) => n.address || n.nodeId.slice(0, 8)).join(', ') ?? '';
  const right = detail.sides[1]?.nodes.map((n) => n.address || n.nodeId.slice(0, 8)).join(', ') ?? '';
  const kinds = [...new Set(detail.disagreements.map((d) => d.kind.replace('_', ' ')))].join(', ');
  if (left && right) {
    return `${left} disagrees with ${right} (${kinds}).`;
  }
  return `Cluster nodes disagree about ${kinds || 'cluster topology'}.`;
}

export function TopologyDivergenceBanner({
  report,
}: {
  report: TopologyDivergenceReport | undefined;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const active = (report?.divergences ?? []).filter(
    (d) => d.confirmed && d.eventId !== null && !dismissed.has(divergenceKey(d)),
  );

  if (active.length === 0) return null;

  const dismiss = async (detail: TopologyDivergenceDetail) => {
    if (!detail.eventId) return;
    try {
      const { success } = await metricsApi.resolveAnomalyEvent(detail.eventId);
      if (!success) return;
    } catch {
      return;
    }
    const key = divergenceKey(detail);
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  return (
    <div className="space-y-2">
      {active.map((detail) => {
        const isCritical = detail.disagreements.some((d) => d.kind === 'slot_owner');
        const key = divergenceKey(detail);
        return (
          <Alert
            key={key}
            variant={isCritical ? 'destructive' : 'default'}
            className={
              isCritical ? 'border-destructive' : 'border-yellow-500 text-yellow-500'
            }
          >
            <AlertTriangle className="w-4 h-4" />
            <AlertTitle>Cluster view disagreement</AlertTitle>
            <AlertDescription>
              <p className="font-medium">{formatDivergenceSummary(detail)}</p>
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" variant="outline" asChild>
                  <Link to={incidentEventPath(detail.eventId!, detail.since)}>View anomaly</Link>
                </Button>
                <Button size="sm" variant="outline" onClick={() => dismiss(detail)}>
                  Mark resolved
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        );
      })}
    </div>
  );
}
