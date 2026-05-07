import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { fetchApi } from '../api/client';

interface DemoState { isDemo: boolean; loading: boolean; }

const DemoContext = createContext<DemoState>({ isDemo: false, loading: true });

export function DemoProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DemoState>({ isDemo: false, loading: true });
  useEffect(() => {
    fetchApi<{ demo: boolean }>('/system/demo')
      .then(r => setState({ isDemo: r.demo, loading: false }))
      .catch(() => setState({ isDemo: false, loading: false }));
  }, []);
  return <DemoContext.Provider value={state}>{children}</DemoContext.Provider>;
}

export function useIsDemo(): boolean {
  return useContext(DemoContext).isDemo;
}

export function useDemoState(): DemoState {
  return useContext(DemoContext);
}
