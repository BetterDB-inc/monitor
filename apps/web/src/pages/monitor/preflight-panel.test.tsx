import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PreflightResult } from '../../api/monitor';
import { PreflightPanel } from './preflight-panel';

function makePreflight(signals: Partial<PreflightResult['health']['signals']>): PreflightResult {
  return {
    connectionId: 'conn-1',
    provider: { provider: 'self-hosted', restrictions: [] },
    acl: { username: 'default', hasMonitor: true },
    health: {
      allow: true,
      signals: {
        memoryPct: 0.1,
        oomEventsRecent: 0,
        replicationLagBytes: 0,
        replicaLinkDown: false,
        failoverInProgress: false,
        ...signals,
      },
      thresholds: { memoryPctThreshold: 0.85, replicationLagThresholdBytes: 10485760 },
    },
    monitorSupport: null,
    throughput: {
      opsPerSec: 0,
      inputKbps: 0,
      outputKbps: 0,
      durationMs: 60000,
      estimatedLines: 0,
      estimatedBytes: 0,
    },
  };
}

function replicaLinkValue(): string | null {
  return screen.getByText('Replica link').nextElementSibling?.textContent ?? null;
}

describe('PreflightPanel replica link', () => {
  it.each([
    [true, 'unhealthy'],
    [false, 'ok'],
    [null, 'n/a'],
  ])('shows replicaLinkDown=%s as %s', (replicaLinkDown, label) => {
    render(<PreflightPanel preflight={makePreflight({ replicaLinkDown })} />);
    expect(replicaLinkValue()).toBe(label);
  });

  it('shows unmeasured replication lag as unavailable instead of 0 B', () => {
    render(<PreflightPanel preflight={makePreflight({ replicationLagBytes: null })} />);
    expect(screen.getByText('Replication lag').nextElementSibling?.textContent).toBe('unavailable');
  });
});
