import { describe, expect, it } from 'vitest';
import { affectedRangeLabel, affectedRangesLabel } from './affected-range';

describe('affectedRangeLabel', () => {
  it('names the lower bound so the range does not read as everything below the ceiling', () => {
    expect(
      affectedRangeLabel({ branch: '7.2', vulnerableFrom: '7.2.4', vulnerableAtOrBelow: '7.2.9' }),
    ).toBe('7.2.4 – 7.2.9');
  });

  it('keeps the at-or-below form when the advisory states no lower bound', () => {
    expect(affectedRangeLabel({ branch: '8.0', vulnerableAtOrBelow: '8.0.9' })).toBe('≤ 8.0.9');
  });

  it('lists every branch range rather than only the first', () => {
    const label = affectedRangesLabel([
      { branch: '7.2', vulnerableFrom: '7.2.4', vulnerableAtOrBelow: '7.2.9' },
      { branch: '8.0', vulnerableAtOrBelow: '8.0.9' },
    ]);

    expect(label).toBe('7.2.4 – 7.2.9, ≤ 8.0.9');
  });

  it('names an exclusive ceiling as the patched version it excludes, not as undefined', () => {
    expect(affectedRangeLabel({ branch: '7.2', vulnerableBelow: '7.2.13' })).toBe('< 7.2.13');
    expect(
      affectedRangeLabel({ branch: '7.2', vulnerableFrom: '7.2.4', vulnerableBelow: '7.2.13' }),
    ).toBe('≥ 7.2.4, < 7.2.13');
  });

  it('skips a range that carries no upper bound at all rather than printing undefined', () => {
    expect(affectedRangeLabel({ branch: '7.2' })).toBeNull();
    expect(
      affectedRangesLabel([{ branch: '7.2' }, { branch: '8.0', vulnerableBelow: '8.0.10' }]),
    ).toBe('< 8.0.10');
  });

  it('renders nothing when the advisory has no affected range at all', () => {
    expect(affectedRangesLabel([])).toBeNull();
  });
});
