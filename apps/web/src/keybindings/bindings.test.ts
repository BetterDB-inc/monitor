import { describe, it, expect } from 'vitest';
import { NAV_CHORDS, labelFor, sequenceFor } from './bindings';

describe('navigation chord table', () => {
  it('never makes one chord the prefix of another', () => {
    // The constraint that matters: `g a` fires the moment `a` lands, so a
    // longer `g a c` could never complete. Getting this wrong silently kills a
    // binding — nothing throws, the route is just unreachable.
    const sequences = NAV_CHORDS.map((chord) => {
      return chord.keys.join(' ');
    });
    const shadowed: string[] = [];

    for (const candidate of sequences) {
      for (const other of sequences) {
        if (candidate !== other && other.startsWith(`${candidate} `)) {
          shadowed.push(`${candidate} shadows ${other}`);
        }
      }
    }

    expect(shadowed).toEqual([]);
  });

  it('binds each chord to exactly one route', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];

    for (const chord of NAV_CHORDS) {
      const key = chord.keys.join(' ');
      const previous = seen.get(key);
      if (previous !== undefined) {
        duplicates.push(`${key}: ${previous} and ${chord.path}`);
      }
      seen.set(key, chord.path);
    }

    expect(duplicates).toEqual([]);
  });

  it('reaches each route from exactly one chord', () => {
    const paths = NAV_CHORDS.map((chord) => {
      return chord.path;
    });

    expect(paths).toHaveLength(new Set(paths).size);
  });

  it('gives every chord a name for the cheat sheet', () => {
    const unnamed = NAV_CHORDS.filter((chord) => {
      return chord.name.trim() === '';
    });

    expect(unnamed).toEqual([]);
  });

  it('prefixes every sequence with the leader', () => {
    expect(sequenceFor(NAV_CHORDS[0])).toEqual(['G', 'D']);
    expect(labelFor({ keys: ['V', 'S'], path: '/x', name: 'X' })).toBe('G V S');
  });
});
