import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import type { KvCacheEngine } from '@betterdb/shared';
import { kvCacheApi } from '../../../api/kv-cache';
import { useCanMutate } from '../../../hooks/useCanMutate';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Switch } from '../../ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table';
import { LinkEngineDialog } from './LinkEngineDialog';
import { useInvalidateEngines } from './useInvalidateEngines';

export function KvCacheEngines({ engines }: { engines: KvCacheEngine[] }) {
  const invalidate = useInvalidateEngines();
  const canMutate = useCanMutate();
  const [linkOpen, setLinkOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<KvCacheEngine | null>(null);

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      kvCacheApi.updateEngine(id, { enabled }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => kvCacheApi.deleteEngine(id),
    onSuccess: async () => {
      await invalidate();
      setPendingDelete(null);
    },
  });

  const closeDelete = () => {
    setPendingDelete(null);
    remove.reset();
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>Engines</CardTitle>
        {canMutate && (
          <Button variant="outline" onClick={() => setLinkOpen(true)}>
            Link engine
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {engines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {canMutate ? 'Link an engine to see hit rate' : 'No engines linked'}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>Last error</TableHead>
                {canMutate && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {engines.map((engine) => (
                <TableRow key={engine.id}>
                  <TableCell>{engine.name}</TableCell>
                  <TableCell>{engine.source === 'scrape' ? 'Scrape' : 'OTLP'}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {engine.scrapeUrl ?? engine.otlpEngineId}
                  </TableCell>
                  <TableCell>
                    <Switch
                      aria-label={`Enable ${engine.name}`}
                      checked={engine.enabled}
                      disabled={!canMutate || toggle.isPending}
                      onCheckedChange={(enabled: boolean) =>
                        toggle.mutate({ id: engine.id, enabled })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    {engine.lastSeenAt
                      ? formatDistanceToNow(engine.lastSeenAt, { addSuffix: true })
                      : 'Never'}
                  </TableCell>
                  <TableCell>
                    {engine.lastError ? <Badge variant="destructive">{engine.lastError}</Badge> : null}
                  </TableCell>
                  {canMutate && (
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => setPendingDelete(engine)}>
                        Delete
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <LinkEngineDialog open={linkOpen} onOpenChange={setLinkOpen} />
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) closeDelete();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete engine</DialogTitle>
            <DialogDescription>
              Remove {pendingDelete?.name} and its stored samples. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {remove.error instanceof Error ? (
            <p className="text-sm text-destructive">{remove.error.message}</p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={closeDelete}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => pendingDelete && remove.mutate(pendingDelete.id)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
