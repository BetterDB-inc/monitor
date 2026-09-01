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

  it('renders nothing when the advisory has no affected range at all', () => {
    expect(affectedRangesLabel([])).toBeNull();
  });
});
