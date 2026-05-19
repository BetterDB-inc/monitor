import { createContext, useContext } from 'react';
import type {
  DatabaseCapabilities,
  RuntimeCapabilities,
  RuntimeCapabilityReasons,
} from '../types/metrics';

export interface CapabilitiesState {
  static: DatabaseCapabilities | null;
  runtime: RuntimeCapabilities | null;
  reasons: RuntimeCapabilityReasons;
  /**
   * Re-enable a runtime capability for the current connection so it'll be
   * retried on the next poll. Optional because it is provided by App.tsx;
   * tests and isolated component mounts may leave it undefined.
   */
  retryCapability?: (capability: keyof RuntimeCapabilities) => Promise<void>;
}

export const CapabilitiesContext = createContext<CapabilitiesState>({
  static: null,
  runtime: null,
  reasons: {},
});

export function useCapabilities() {
  const { static: capabilities, runtime, reasons, retryCapability } = useContext(CapabilitiesContext);

  return {
    capabilities,
    runtime,
    reasons,
    retryCapability,
    isValkey: capabilities?.dbType === 'valkey',
    hasSlowLog: runtime?.canSlowLog ?? true,
    hasCommandLog: (capabilities?.hasCommandLog ?? false) && (runtime?.canCommandLog ?? true),
    hasAclLog: (capabilities?.hasAclLog ?? false) && (runtime?.canAclLog ?? true),
    hasClientList: runtime?.canClientList ?? true,
    hasSlotStats: capabilities?.hasSlotStats ?? false,
    hasClusterSlotStats:
      (capabilities?.hasClusterSlotStats ?? false) && (runtime?.canClusterSlotStats ?? true),
    hasLatency: runtime?.canLatency ?? true,
    hasMemory: runtime?.canMemory ?? true,
    hasVectorSearch: capabilities?.hasVectorSearch ?? false,
  };
}
