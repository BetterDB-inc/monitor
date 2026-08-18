import type { ReactNode } from 'react';
import { MigrationPlanContext, useMigrationPlanState } from '../../hooks/useMigrationPlan';

interface Props {
  children: ReactNode;
}

export function MigrationPlanProvider({ children }: Props) {
  const plan = useMigrationPlanState();

  return <MigrationPlanContext.Provider value={plan}>{children}</MigrationPlanContext.Provider>;
}
