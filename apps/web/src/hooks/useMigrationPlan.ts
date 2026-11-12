import { createContext, useContext, useState } from 'react';
import type { MigrationTargetProfile } from '@betterdb/shared';
import { useConnection } from './useConnection';
import { isExternalConnection } from '../utils/connectionType';

export const DEFAULT_SCAN_SAMPLE_SIZE = 10000;

export interface MigrationPlanContextValue {
  /** Connection the data is copied from */
  sourceId: string | null;
  /** Connection the data is copied into */
  targetId: string | null;
  targetProfile: MigrationTargetProfile | null;
  /** Whether the source was picked deliberately rather than seeded from the current connection */
  sourceChosen: boolean;
  /** How many keys the analysis samples with SCAN */
  scanSampleSize: number;
  chooseSource: (connectionId: string) => void;
  chooseTarget: (connectionId: string) => void;
  chooseTargetProfile: (profile: MigrationTargetProfile) => void;
  clearSource: () => void;
  clearTarget: () => void;
  setScanSampleSize: (size: number) => void;
}

export const MigrationPlanContext = createContext<MigrationPlanContextValue | null>(null);

export function useMigrationPlan(): MigrationPlanContextValue {
  const context = useContext(MigrationPlanContext);
  if (context === null) {
    throw new Error('useMigrationPlan must be used within a MigrationPlanProvider');
  }
  return context;
}

/**
 * Hook to create migration plan state.
 * Held above the step panels so the plan survives moving between steps.
 */
export function useMigrationPlanState(): MigrationPlanContextValue {
  const { currentConnection } = useConnection();
  const [sourceId, setSourceId] = useState<string | null>(
    isExternalConnection(currentConnection) ? null : (currentConnection?.id ?? null),
  );
  const [targetId, setTargetId] = useState<string | null>(null);
  const [targetProfile, setTargetProfile] = useState<MigrationTargetProfile | null>(null);
  const [sourceChosen, setSourceChosen] = useState(false);
  const [scanSampleSize, setScanSampleSize] = useState(DEFAULT_SCAN_SAMPLE_SIZE);

  const chooseSource = (connectionId: string) => {
    setSourceId(connectionId);
    setSourceChosen(true);
  };

  const chooseTarget = (connectionId: string) => {
    setTargetId(connectionId);
    setTargetProfile(null);
  };

  const chooseTargetProfile = (profile: MigrationTargetProfile) => {
    setTargetProfile(profile);
    setTargetId(null);
  };

  const clearSource = () => {
    setSourceId(null);
    setSourceChosen(false);
  };

  const clearTarget = () => {
    setTargetId(null);
    setTargetProfile(null);
  };

  return {
    sourceId,
    targetId,
    targetProfile,
    sourceChosen,
    scanSampleSize,
    chooseSource,
    chooseTarget,
    chooseTargetProfile,
    clearSource,
    clearTarget,
    setScanSampleSize,
  };
}
