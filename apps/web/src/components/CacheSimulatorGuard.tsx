import { Feature } from '@betterdb/shared';
import { useLicense, useLicenseStatus } from '../hooks/useLicense';
import { Skeleton } from './ui/skeleton';
import { CacheSimulatorProLocked } from './pages/cache-simulator';

interface Props {
  children: React.ReactNode;
}

export function CacheSimulatorGuard({ children }: Props) {
  const { hasFeature } = useLicense();
  const { loading } = useLicenseStatus();
  if (loading) return <Skeleton className="h-40 w-full" />;
  if (!hasFeature(Feature.CACHE_SIZE_SIMULATOR)) return <CacheSimulatorProLocked />;
  return <>{children}</>;
}
