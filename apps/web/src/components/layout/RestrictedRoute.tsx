import { ReactElement, ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useDemoState } from '../../contexts/DemoContext';
import { useCanMutate } from '../../hooks/useCanMutate';

export function RestrictedRoute({ children }: { children: ReactNode }): ReactElement | null {
  const { isDemo, loading } = useDemoState();
  const canMutate = useCanMutate();
  if (loading === true) {
    return null;
  }
  if (isDemo === true || canMutate === false) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
