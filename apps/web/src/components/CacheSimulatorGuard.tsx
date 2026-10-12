import { Feature } from '@betterdb/shared';
import { useLicense } from '../hooks/useLicense';
import { CacheSimulatorProLocked } from './pages/cache-simulator';

interface Props {
  children: React.ReactNode;
}

export function CacheSimulatorGuard({ children }: Props) {
  const { hasFeature } = useLicense();
  if (!hasFeature(Feature.CACHE_SIZE_SIMULATOR)) return <CacheSimulatorProLocked />;
  return <>{children}</>;
}
