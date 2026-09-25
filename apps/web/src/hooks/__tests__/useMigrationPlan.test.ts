import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const connectionState = vi.hoisted(() => ({
  currentConnection: null as { id: string; connectionType?: string } | null,
}));

vi.mock('../useConnection', () => ({
  useConnection: () => connectionState,
}));

import { useMigrationPlanState } from '../useMigrationPlan';

describe('useMigrationPlanState', () => {
  it('seeds the source from a directly connected instance', () => {
    connectionState.currentConnection = { id: 'direct-1', connectionType: 'direct' };
    const { result } = renderHook(() => useMigrationPlanState());
    expect(result.current.sourceId).toBe('direct-1');
    expect(result.current.sourceChosen).toBe(false);
  });

  it('leaves the source empty when the current connection is external', () => {
    connectionState.currentConnection = { id: 'otlp-1', connectionType: 'external' };
    const { result } = renderHook(() => useMigrationPlanState());
    expect(result.current.sourceId).toBeNull();
  });

  it('leaves the source empty without a current connection', () => {
    connectionState.currentConnection = null;
    const { result } = renderHook(() => useMigrationPlanState());
    expect(result.current.sourceId).toBeNull();
  });
});
