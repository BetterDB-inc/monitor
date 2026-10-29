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
  plateauBytes: number | null;
  horizonLabel: string;
}

const PROVIDERS: Array<{ id: CloudProvider; label: string }> = [
  { id: 'aws', label: 'AWS' },
  { id: 'gcp', label: 'GCP' },
  { id: 'azure', label: 'Azure' },
];

function unlimitedHeadline(change: number, plateauBytes: number | null, horizonLabel: string): string {
  if (change > 0 && plateauBytes !== null) return `No maxmemory limit is set. Memory grows, then levels off near ${formatBytes(plateauBytes)} as keys expire.`;
  if (change > 0) return 'No maxmemory limit is set, so memory grows until the host runs out.';
  if (change < 0) return `No maxmemory limit is set. Memory shrinks over the next ${horizonLabel}.`;
  return `No maxmemory limit is set. Memory stays flat over the next ${horizonLabel}.`;
}

function limitedHeadline(sizing: Projection, maxmemory: number): string {
  if (sizing.daysToMaxmemory === 0) return 'Already at maxmemory.';
  if (sizing.daysToMaxmemory !== null) return `Reaches maxmemory in ~${sizing.daysToMaxmemory} days.`;
  const rangeDay = sizing.points.find((point) => point.high >= maxmemory)?.day;
  if (rangeDay === undefined) return 'Stays under maxmemory for at least 6 months.';
  return `Stays under maxmemory for at least 6 months at the projected rate, but the upper end of the range reaches it in ~${rangeDay} days.`;
}

export function OutcomePanel({ projection, sizingProjection, maxmemory, policy, plateauBytes, horizonLabel }: Props) {
  const [provider, setProvider] = useState<CloudProvider>('aws');
  const peak = Math.max(...sizingProjection.points.map((point) => point.high));
  const change = projection.points[projection.points.length - 1].bytes - projection.points[0].bytes;
  const hasRange = sizingProjection.points.some((point) => point.high > point.bytes);
  const headline = maxmemory === null ? unlimitedHeadline(change, plateauBytes, horizonLabel) : limitedHeadline(sizingProjection, maxmemory);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">What happens next</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="font-medium">{headline}</p>
        {maxmemory !== null && policy === 'mixed' && (
          <p className="text-sm">The cluster primaries use different eviction policies, so what happens at maxmemory differs by shard.</p>
        )}
        {maxmemory !== null && policy !== 'mixed' && (
          <p className="text-sm">
            With <span className="font-mono">{policy}</span>: {evictionConsequence(policy)}
          </p>
        )}
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {hasRange
              ? `Smallest nodes that keep the 6-month projection's highest point, at the upper end of its range (${formatBytes(peak)}), under 80% of usable memory:`
              : `Smallest nodes that keep the 6-month projection's highest point (${formatBytes(peak)}) under 80% of usable memory:`}
          </p>
          <Tabs value={provider} onValueChange={(value) => setProvider(value as CloudProvider)}>
            <TabsList>
              {PROVIDERS.map((entry) => (
                <TabsTrigger key={entry.id} value={entry.id}>
                  {entry.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {PROVIDERS.map((entry) => {
              const nodes = smallestNodeFor(peak, entry.id);
              return (
                <TabsContent key={entry.id} value={entry.id}>
                  {nodes.length === 0 ? (
                    <p className="text-sm">No {entry.label} node in the catalog fits this projection, even at the maximum shard count.</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {nodes.map((rec) => (
                        <li key={rec.service}>
                          {rec.label}: <span className="font-mono">{rec.nodeType}</span> ({formatBytes(rec.memoryBytes)})
                          {rec.shards > 1 && ` × ${rec.shards} shards`}
                        </li>
                      ))}
                    </ul>
                  )}
                </TabsContent>
              );
            })}
          </Tabs>
        </div>
      </CardContent>
    </Card>
  );
}
