import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CLUSTER_NODE_PARAM, CLUSTER_TAB_PARAM } from '@betterdb/shared';

export const CLUSTER_TABS = [
  'overview',
  'nodes',
  'replication',
  'slowlog',
  'disagreements',
] as const;
export type ClusterTab = (typeof CLUSTER_TABS)[number];

function tabOf(value: string | null): ClusterTab {
  return CLUSTER_TABS.find((tab) => tab === value) ?? 'overview';
}

export function useClusterTab(): [ClusterTab, (tab: string) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = tabOf(searchParams.get(CLUSTER_TAB_PARAM));

  const setTab = useCallback(
    (next: string) => {
      setSearchParams(
        (previous) => {
          const params = new URLSearchParams(previous);
          const chosen = tabOf(next);
          if (chosen === 'overview') {
            params.delete(CLUSTER_TAB_PARAM);
          } else {
            params.set(CLUSTER_TAB_PARAM, chosen);
          }
          if (chosen !== 'nodes') params.delete(CLUSTER_NODE_PARAM);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return [tab, setTab];
}
