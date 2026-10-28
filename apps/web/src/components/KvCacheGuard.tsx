import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Feature } from '@betterdb/shared';
import { kvCacheApi, kvCacheKeys } from '../api/kv-cache';
import { awaitingFirstScan, kvCacheInUse, useKvCacheStatus } from '../hooks/useKvCacheStatus';
import { useCanEditKvCache } from '../hooks/useCanEditKvCache';
import { useConnection } from '../hooks/useConnection';
import { useLicense, useLicenseStatus } from '../hooks/useLicense';
import { hasKvCacheFootprint } from '../utils/connectionType';
import { KvCacheNotDetected, KvCacheProLocked, LinkEngineDialog } from './pages/kv-cache';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Skeleton } from './ui/skeleton';

const PAST_DETECTION_MS = 30 * 24 * 60 * 60 * 1000;

interface Props {
  children: React.ReactNode;
}

export function KvCacheGuard({ children }: Props) {
  const { license, hasFeature } = useLicense();
  const { loading: licenseLoading } = useLicenseStatus();
  const { currentConnection } = useConnection();
  const status = useKvCacheStatus();
  const [linkOpen, setLinkOpen] = useState(false);
  const connectionId = currentConnection?.id ?? null;
  const pastDetection = useQuery({
    queryKey: [...kvCacheKeys.historyAll(connectionId), 'past-detection'],
    queryFn: async ({ signal }) => {
      const end = Date.now();
      const history = await kvCacheApi.getFootprintHistory(end - PAST_DETECTION_MS, end, signal);
      return history.some((snapshot) => snapshot.detected);
    },
    enabled: connectionId !== null && status.data !== undefined && !kvCacheInUse(status.data),
  });

  if (license === null && licenseLoading) {
    return <GuardSkeleton />;
  }
  if (!hasFeature(Feature.KV_CACHE_MONITORING)) {
    return <KvCacheProLocked />;
  }
  if (!hasKvCacheFootprint(currentConnection)) {
    return (
      <p className="text-sm text-muted-foreground">
        KV cache footprint is not collected for this connection. Open the cluster seed or the
        Sentinel primary connection to see it.
      </p>
    );
  }
  if (status.isError && !status.data) {
    return <p className="text-sm text-destructive">Could not load KV cache status</p>;
  }
  if (!status.data) {
    return <GuardSkeleton />;
  }
  if (awaitingFirstScan(status.data)) {
    return (
      <>
        <FirstScanPending onLinkEngine={() => setLinkOpen(true)} />
        <LinkEngineDialog open={linkOpen} onOpenChange={setLinkOpen} />
      </>
    );
  }
  const notDetected = (
    <KvCacheNotDetected latest={status.data.latest} onLinkEngine={() => setLinkOpen(true)} />
  );
  return (
    <>
      {kvCacheInUse(status.data) ? (
        children
      ) : pastDetection.data ? (
        <div className="space-y-6">
          {notDetected}
          {children}
        </div>
      ) : (
        notDetected
      )}
      <LinkEngineDialog open={linkOpen} onOpenChange={setLinkOpen} />
    </>
  );
}

function FirstScanPending({ onLinkEngine }: { onLinkEngine: () => void }) {
  const canMutate = useCanEditKvCache();
  return (
    <div className="flex items-center justify-center py-8">
      <Card className="max-w-2xl shadow-lg">
        <CardHeader>
          <CardTitle>Scanning for LMCache keys</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          The first scan of this connection has not finished yet. This page updates when it does.
          {canMutate && (
            <div className="pt-2">
              <Button variant="outline" onClick={onLinkEngine}>
                Link an engine
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function GuardSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
