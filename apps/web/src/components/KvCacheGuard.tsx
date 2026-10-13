import { useState } from 'react';
import { Feature } from '@betterdb/shared';
import { kvCacheInUse, useKvCacheStatus } from '../hooks/useKvCacheStatus';
import { useLicense } from '../hooks/useLicense';
import { KvCacheNotDetected, KvCacheProLocked, LinkEngineDialog } from './pages/kv-cache';
import { Skeleton } from './ui/skeleton';

interface Props {
  children: React.ReactNode;
}

export function KvCacheGuard({ children }: Props) {
  const { hasFeature } = useLicense();
  const status = useKvCacheStatus();
  const [linkOpen, setLinkOpen] = useState(false);

  if (!hasFeature(Feature.KV_CACHE_MONITORING)) {
    return <KvCacheProLocked />;
  }
  if (status.isError && !status.data) {
    return <p className="text-sm text-destructive">Could not load KV cache status</p>;
  }
  if (!status.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  return (
    <>
      {kvCacheInUse(status.data) ? (
        children
      ) : (
        <KvCacheNotDetected latest={status.data.latest} onLinkEngine={() => setLinkOpen(true)} />
      )}
      <LinkEngineDialog open={linkOpen} onOpenChange={setLinkOpen} />
    </>
  );
}
