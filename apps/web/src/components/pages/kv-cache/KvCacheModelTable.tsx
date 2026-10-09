import type { KvCacheFootprintSnapshot, KvCacheSampleBucket } from '@betterdb/shared';
import { formatBytes } from '../../../lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../ui/table';
import { formatPercent, modelHitRates } from './kv-cache-format';

interface Props {
  latest: KvCacheFootprintSnapshot;
  buckets: KvCacheSampleBucket[];
}

export function KvCacheModelTable({ latest, buckets }: Props) {
  const rates = modelHitRates(buckets);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Models</CardTitle>
      </CardHeader>
      <CardContent>
        {latest.perModel.length === 0 ? (
          <p className="text-sm text-muted-foreground">No models found in the last scan.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>dtype</TableHead>
                <TableHead>Layout</TableHead>
                <TableHead className="text-right">Chunks</TableHead>
                <TableHead className="text-right">Bytes</TableHead>
                <TableHead className="text-right">Hit rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {latest.perModel.map((entry) => (
                <TableRow key={`${entry.model}|${entry.dtype}`}>
                  <TableCell className="font-mono text-xs">{entry.model}</TableCell>
                  <TableCell>{entry.dtype}</TableCell>
                  <TableCell>{latest.layout ?? '—'}</TableCell>
                  <TableCell className="text-right">{entry.chunksEst.toLocaleString()}</TableCell>
                  <TableCell className="text-right">{formatBytes(entry.bytesEst)}</TableCell>
                  <TableCell className="text-right">
                    {formatPercent(rates.get(entry.model) ?? null)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
