import { createContext, useContext } from 'react';
import type { DatabaseCapabilities, RuntimeCapabilities } from '../types/metrics';

export interface CapabilitiesState {
  static: DatabaseCapabilities | null;
  runtime: RuntimeCapabilities | null;
}

export const CapabilitiesContext = createContext<CapabilitiesState>({
  static: null,
  runtime: null,
});

export function useCapabilities() {
  const { static: capabilities, runtime } = useContext(CapabilitiesContext);

  return {
    capabilities,
    runtime,
    isValkey: capabilities?.dbType === 'valkey',
    hasSlowLog: runtime?.canSlowLog ?? true,
    hasCommandLog: (capabilities?.hasCommandLog ?? false) && (runtime?.canCommandLog ?? true),
    hasAclLog: (capabilities?.hasAclLog ?? false) && (runtime?.canAclLog ?? true),
    hasClientList: runtime?.canClientList ?? true,
    hasSlotStats: capabilities?.hasSlotStats ?? false,
    hasClusterSlotStats: (capabilities?.hasClusterSlotStats ?? false) && (runtime?.canClusterSlotStats ?? true),
    hasLatency: runtime?.canLatency ?? true,
    hasMemory: runtime?.canMemory ?? true,
  };
}
