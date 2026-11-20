import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button';
import { metricsApi } from '@/api/metrics';

export interface TopologyDivergenceEvent {
  id: string;
  timestamp: number;
  metricType: string;
  severity: string;
  message: string;
  resolved?: boolean;
}

export function TopologyDivergenceBanner({
  events,
}: {
  events: TopologyDivergenceEvent[] | undefined;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const active = (events ?? []).filter(
    (e) => e.metricType === 'topology_divergence' && !e.resolved && !dismissed.has(e.id),
  );

  if (active.length === 0) return null;

  const dismiss = async (id: string) => {
    try {
      const { success } = await metricsApi.resolveAnomalyEvent(id);
      if (!success) return;
    } catch {
      return;
    }
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-2">
      {active.map((event) => (
        <Alert
          key={event.id}
          variant={event.severity === 'critical' ? 'destructive' : 'default'}
          className={
            event.severity === 'critical' ? 'border-destructive' : 'border-yellow-500 text-yellow-500'
          }
        >
          <AlertTriangle className="w-4 h-4" />
          <AlertTitle>Cluster view disagreement</AlertTitle>
          <AlertDescription>
            <p className="font-medium">{event.message}</p>
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" variant="outline" asChild>
                <Link to="/anomalies">View anomaly</Link>
              </Button>
              <Button size="sm" variant="outline" onClick={() => dismiss(event.id)}>
                Mark resolved
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}
