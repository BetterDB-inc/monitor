import { useState } from 'react';
import { evictionConsequence, smallestNodeFor, type CloudProvider, type Projection } from '@betterdb/shared';
import { formatBytes } from '../../../lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs';

interface Props {
  projection: Projection;
  sizingProjection: Projection;
  maxmemory: number | null;
  policy: string;
  horizonLabel: string;
}

const PROVIDERS: Array<{ id: CloudProvider; label: string }> = [
  { id: 'aws', label: 'AWS' },
  { id: 'gcp', label: 'GCP' },
  { id: 'azure', label: 'Azure' },
];

export function OutcomePanel({ projection, sizingProjection, maxmemory, policy, horizonLabel }: Props) {
  const [provider, setProvider] = useState<CloudProvider>('aws');
  const peak = Math.max(...sizingProjection.points.map((point) => point.high));
  const headline =
    maxmemory === null
      ? 'No maxmemory limit is set, so memory grows until the host runs out.'
      : projection.daysToMaxmemory === null
        ? `Stays under maxmemory for the next ${horizonLabel}.`
        : projection.daysToMaxmemory === 0
          ? 'Already at maxmemory.'
          : `Reaches maxmemory in ~${projection.daysToMaxmemory} days.`;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">What happens next</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="font-medium">{headline}</p>
        {maxmemory !== null && (
          <p className="text-sm">
            With <span className="font-mono">{policy}</span>: {evictionConsequence(policy)}
          </p>
        )}
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Smallest nodes that keep the 6-month projection ({formatBytes(peak)}) under 80% of usable memory:</p>
          <Tabs value={provider} onValueChange={(value) => setProvider(value as CloudProvider)}>
            <TabsList>
              {PROVIDERS.map((entry) => (
                <TabsTrigger key={entry.id} value={entry.id}>
                  {entry.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {PROVIDERS.map((entry) => (
              <TabsContent key={entry.id} value={entry.id}>
                <ul className="space-y-1 text-sm">
                  {smallestNodeFor(peak, entry.id).map((rec) => (
                    <li key={rec.service}>
                      {rec.label}: <span className="font-mono">{rec.nodeType}</span> ({formatBytes(rec.memoryBytes)})
                      {rec.shards > 1 && ` × ${rec.shards} shards`}
                    </li>
                  ))}
                </ul>
              </TabsContent>
            ))}
          </Tabs>
        </div>
      </CardContent>
    </Card>
  );
}
