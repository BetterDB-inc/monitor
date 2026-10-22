import { useIsDemo } from '../contexts/DemoContext';
import { useCanMutate } from './useCanMutate';

export function useCanEditKvCache(): boolean {
  const canMutate = useCanMutate();
  const isDemo = useIsDemo();
  return canMutate && !isDemo;
}
