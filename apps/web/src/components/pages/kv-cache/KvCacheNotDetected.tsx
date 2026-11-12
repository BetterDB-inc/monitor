import { useEffect, useRef } from 'react';
import type { KvCacheFootprintSnapshot } from '@betterdb/shared';
import { useCanEditKvCache } from '../../../hooks/useCanEditKvCache';
import { useRescanKvCache } from '../../../hooks/useRescanKvCache';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { Button } from '../../ui/button';

const DOCS_URL = 'https://docs.betterdb.com/kv-cache-monitoring';
const EXAMPLE_KEY = 'Qwen/Qwen2.5-0.5B-Instruct@1@0@9e3779b97f4a7c15@bfloat16';
const MP_KEY_SHAPE = '[<key_prefix>@]<model>@<kv_rank:08x>@<group_hex>@<chunk_hash_hex>[@<cache_salt>]';

interface Props {
  latest: KvCacheFootprintSnapshot | null;
  onLinkEngine: () => void;
  pending?: boolean;
  scanError?: string | null;
  intervalMs?: number;
  cooldownUntil?: number | null;
}

function formatInterval(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60 || minutes % 60 !== 0) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = minutes / 60;
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

export function KvCacheNotDetected({
  latest,
  onLinkEngine,
  pending = false,
  scanError = null,
  intervalMs,
  cooldownUntil = null,
}: Props) {
  const rescan = useRescanKvCache();
  const canMutate = useCanEditKvCache();
  const { mutate } = rescan;
  const triggered = useRef(false);

  useEffect(() => {
    if (!pending || !canMutate || triggered.current) return;
    triggered.current = true;
    mutate();
  }, [pending, canMutate, mutate]);

  const rescanMessage = rescan.error instanceof Error ? rescan.error.message : '';
  const showRescanError = rescan.isError && !(scanError && rescanMessage === scanError);
  const title = pending
    ? 'Scanning for LMCache keys'
    : scanError && !latest
      ? 'Could not scan for LMCache keys'
      : 'No LMCache KV cache detected';

  return (
    <div className="flex items-center justify-center py-8">
      <Card className="max-w-2xl shadow-lg">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {scanError && (
            <p className="text-destructive">
              The last scan failed: {scanError}
              <span className="block text-muted-foreground">
                BetterDB retries within{' '}
                {intervalMs
                  ? formatInterval(intervalMs + Math.max(0, (cooldownUntil ?? 0) - Date.now()))
                  : 'the footprint interval'}
                .
              </span>
            </p>
          )}
          {pending && !scanError && (
            <p className="text-muted-foreground">
              The first scan of this connection has not finished yet. This page updates when it does.
            </p>
          )}
          <p className="text-muted-foreground">
            BetterDB looks for LMCache chunk keys in this connection&apos;s database. Keys have
            the shape{' '}
            <code className="font-mono">
              &lt;model&gt;@&lt;world_size&gt;@&lt;worker_id&gt;@&lt;chunk_hash&gt;@&lt;dtype&gt;
            </code>
            , for example:
          </p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
            {EXAMPLE_KEY}
          </pre>
          <p className="text-muted-foreground">
            LMCache&apos;s multiprocess (MP) Valkey adapter writes one key per chunk object as{' '}
            <code className="font-mono">{MP_KEY_SHAPE}</code>.
          </p>
          <p className="text-muted-foreground">
            <code className="font-mono">redis://</code> stores write two keys per chunk, ending in{' '}
            <code className="font-mono">kv_bytes</code> and <code className="font-mono">metadata</code>.{' '}
            <code className="font-mono">valkey://</code> clients on this database are recognised by{' '}
            <code className="font-mono">lib-name=GlidePySync(lmcache:…)</code> or{' '}
            <code className="font-mono">lib-name=GlidePySync(lmcache)</code>.
          </p>
          <p className="text-muted-foreground">
            Only this connection&apos;s database is scanned.
            {latest && latest.otherDbs.length > 0 && (
              <>
                {' '}
                Other databases with keys: {latest.otherDbs.map((db) => `db${db}`).join(', ')}
              </>
            )}
          </p>
          {latest && (
            <p className="text-muted-foreground">
              Last scan: {latest.scannedKeys.toLocaleString()} keys scanned,{' '}
              {latest.matchedKeys.toLocaleString()} matched.
            </p>
          )}
          <div className="flex items-center gap-3 pt-2">
            {canMutate && (
              <Button onClick={() => rescan.mutate()} disabled={rescan.isPending}>
                Rescan now
              </Button>
            )}
            {canMutate && (
              <Button variant="outline" onClick={onLinkEngine}>
                Link an engine
              </Button>
            )}
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline"
            >
              Read the docs
            </a>
          </div>
          {showRescanError && (
            <p className="text-destructive">
              Could not rescan
              {rescanMessage ? `: ${rescanMessage}` : ''}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
