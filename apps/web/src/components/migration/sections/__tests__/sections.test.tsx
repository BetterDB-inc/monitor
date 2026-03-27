import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type {
  KeyCountComparison,
  SampleValidationResult,
  BaselineComparison,
} from '@betterdb/shared';
import { InfoTip } from '../InfoTip';
import { KeyCountSection } from '../KeyCountSection';
import { SampleValidationSection } from '../SampleValidationSection';
import { BaselineSection } from '../BaselineSection';

afterEach(() => {
  cleanup();
});

// ── InfoTip ──

describe('InfoTip', () => {
  it('should render an SVG (Info icon)', () => {
    const { container } = render(<InfoTip text="test tooltip" />);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('should set correct data-tooltip-id', () => {
    const { container } = render(<InfoTip text="test tooltip" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('data-tooltip-id')).toBe('info-tip');
  });

  it('should set correct data-tooltip-content', () => {
    const { container } = render(<InfoTip text="My tooltip text" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('data-tooltip-content')).toBe('My tooltip text');
  });
});

// ── KeyCountSection ──

describe('KeyCountSection', () => {
  it('should render "Not available." when keyCount is undefined', () => {
    const { container } = render(<KeyCountSection />);
    expect(container.textContent).toContain('Not available.');
  });

  it('should render source, target, and discrepancy values', () => {
    const keyCount: KeyCountComparison = {
      sourceKeys: 10000,
      targetKeys: 10050,
      discrepancy: 50,
      discrepancyPercent: 0.5,
    };
    render(<KeyCountSection keyCount={keyCount} />);

    expect(screen.getByText('10,000')).toBeDefined();
    expect(screen.getByText('10,050')).toBeDefined();
    expect(screen.getByText('+50 (0.5%)')).toBeDefined();
  });

  it('should show warning text when warning is set', () => {
    const keyCount: KeyCountComparison = {
      sourceKeys: 100,
      targetKeys: 100,
      discrepancy: 0,
      discrepancyPercent: 0,
      warning: 'Multi-DB source detected',
    };
    render(<KeyCountSection keyCount={keyCount} />);

    expect(screen.getByText('Multi-DB source detected')).toBeDefined();
  });

  it('should show type breakdown table when data present', () => {
    const keyCount: KeyCountComparison = {
      sourceKeys: 1000,
      targetKeys: 1000,
      discrepancy: 0,
      discrepancyPercent: 0,
      typeBreakdown: [
        { type: 'string', sourceEstimate: 500, targetEstimate: 500 },
        { type: 'hash', sourceEstimate: 300, targetEstimate: 300 },
      ],
    };
    render(<KeyCountSection keyCount={keyCount} />);

    expect(screen.getByText('string')).toBeDefined();
    expect(screen.getByText('hash')).toBeDefined();
  });

  it('should render discrepancy info tooltip', () => {
    const keyCount: KeyCountComparison = {
      sourceKeys: 100,
      targetKeys: 110,
      discrepancy: 10,
      discrepancyPercent: 10,
    };
    const { container } = render(<KeyCountSection keyCount={keyCount} />);

    const infoIcons = container.querySelectorAll('svg[data-tooltip-id="info-tip"]');
    expect(infoIcons.length).toBeGreaterThanOrEqual(1);
  });
});

// ── SampleValidationSection ──

describe('SampleValidationSection', () => {
  it('should render "Not available." when sample is undefined', () => {
    const { container } = render(<SampleValidationSection />);
    expect(container.textContent).toContain('Not available.');
  });

  it('should render matched count', () => {
    const sample: SampleValidationResult = {
      sampledKeys: 500,
      matched: 495,
      missing: 3,
      typeMismatches: 1,
      valueMismatches: 1,
      issues: [],
    };
    render(<SampleValidationSection sample={sample} />);

    expect(screen.getByText('495')).toBeDefined();
    expect(screen.getByText('/500 matched')).toBeDefined();
  });

  it('should show all-match success message when no mismatches', () => {
    const sample: SampleValidationResult = {
      sampledKeys: 500,
      matched: 500,
      missing: 0,
      typeMismatches: 0,
      valueMismatches: 0,
      issues: [],
    };
    render(<SampleValidationSection sample={sample} />);

    expect(screen.getByText('All sampled keys validated successfully.')).toBeDefined();
  });

  it('should render issues table when issues exist', () => {
    const sample: SampleValidationResult = {
      sampledKeys: 500,
      matched: 498,
      missing: 1,
      typeMismatches: 1,
      valueMismatches: 0,
      issues: [
        { key: 'user:123', type: 'string', status: 'missing', detail: 'Key not found on target' },
        { key: 'data:456', type: 'hash', status: 'type_mismatch', detail: 'Expected hash, got string' },
      ],
    };
    render(<SampleValidationSection sample={sample} />);

    expect(screen.getByText('user:123')).toBeDefined();
    expect(screen.getByText('data:456')).toBeDefined();
    expect(screen.getByText('missing')).toBeDefined();
    expect(screen.getByText('type mismatch')).toBeDefined();
  });

  it('should render sample info tooltip', () => {
    const sample: SampleValidationResult = {
      sampledKeys: 500,
      matched: 500,
      missing: 0,
      typeMismatches: 0,
      valueMismatches: 0,
      issues: [],
    };
    const { container } = render(<SampleValidationSection sample={sample} />);

    const infoIcons = container.querySelectorAll('svg[data-tooltip-id="info-tip"]');
    expect(infoIcons.length).toBeGreaterThanOrEqual(1);
  });
});

// ── BaselineSection ──

describe('BaselineSection', () => {
  it('should render "Not available." when baseline is undefined', () => {
    const { container } = render(<BaselineSection />);
    expect(container.textContent).toContain('Not available.');
  });

  it('should show unavailable reason when available is false', () => {
    const baseline: BaselineComparison = {
      available: false,
      unavailableReason: 'Insufficient snapshots collected before migration.',
      snapshotCount: 2,
      baselineWindowMs: 0,
      metrics: [],
    };
    render(<BaselineSection baseline={baseline} />);

    expect(screen.getByText('Insufficient snapshots collected before migration.')).toBeDefined();
  });

  it('should render metrics table with correct labels', () => {
    const baseline: BaselineComparison = {
      available: true,
      snapshotCount: 10,
      baselineWindowMs: 3600000,
      metrics: [
        { name: 'opsPerSec', sourceBaseline: 1000, targetCurrent: 950, percentDelta: -5, status: 'normal' },
        { name: 'usedMemory', sourceBaseline: 1073741824, targetCurrent: 1073741824, percentDelta: 0, status: 'normal' },
        { name: 'memFragmentationRatio', sourceBaseline: 1.05, targetCurrent: 1.1, percentDelta: 4.8, status: 'normal' },
        { name: 'cpuSys', sourceBaseline: 120.5, targetCurrent: 125.3, percentDelta: 4.0, status: 'normal' },
      ],
    };
    render(<BaselineSection baseline={baseline} />);

    expect(screen.getByText('Ops/sec')).toBeDefined();
    expect(screen.getByText('Used Memory')).toBeDefined();
    expect(screen.getByText('Mem Fragmentation')).toBeDefined();
    expect(screen.getByText('CPU Sys')).toBeDefined();
  });

  it('should render info tooltip icons for each metric', () => {
    const baseline: BaselineComparison = {
      available: true,
      snapshotCount: 10,
      baselineWindowMs: 3600000,
      metrics: [
        { name: 'opsPerSec', sourceBaseline: 1000, targetCurrent: 950, percentDelta: -5, status: 'normal' },
        { name: 'usedMemory', sourceBaseline: 1073741824, targetCurrent: 1073741824, percentDelta: 0, status: 'normal' },
        { name: 'memFragmentationRatio', sourceBaseline: 1.05, targetCurrent: 1.1, percentDelta: 4.8, status: 'normal' },
        { name: 'cpuSys', sourceBaseline: 120.5, targetCurrent: 125.3, percentDelta: 4.0, status: 'normal' },
      ],
    };
    const { container } = render(<BaselineSection baseline={baseline} />);

    const infoIcons = container.querySelectorAll('svg[data-tooltip-id="info-tip"]');
    expect(infoIcons.length).toBe(4);
  });

  it('should format memory values correctly', () => {
    const baseline: BaselineComparison = {
      available: true,
      snapshotCount: 10,
      baselineWindowMs: 3600000,
      metrics: [
        { name: 'usedMemory', sourceBaseline: 1073741824, targetCurrent: 1073741824, percentDelta: 0, status: 'normal' },
      ],
    };
    const { container } = render(<BaselineSection baseline={baseline} />);

    // 1073741824 bytes = 1.00 GB — appears in source baseline and target current columns
    const gbTexts = container.querySelectorAll('td.font-mono');
    const gbValues = Array.from(gbTexts).filter(td => td.textContent === '1.00 GB');
    expect(gbValues.length).toBe(2);
  });
});
