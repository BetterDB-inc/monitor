import { describe, it, expect } from 'vitest';
import { NAV_CHORDS, availableChords, labelFor, sequenceFor } from './bindings';

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

describe('licence gating', () => {
  it('drops chords for features the licence does not cover', () => {
    const chords = availableChords(() => false);

    expect(chords.map((c) => c.path)).not.toContain('/anomalies');
    expect(chords.map((c) => c.path)).not.toContain('/bulk-delete');
  });

  it('keeps ungated chords regardless of licence', () => {
    const chords = availableChords(() => false);

    expect(chords.map((c) => c.path)).toContain('/');
    expect(chords.map((c) => c.path)).toContain('/slowlog');
  });

  it('restores gated chords once the feature is licensed', () => {
    const chords = availableChords(() => true);

    expect(chords).toHaveLength(NAV_CHORDS.length);
    expect(chords.map((c) => c.path)).toContain('/anomalies');
  });

  it('gates exactly the routes the sidebar gates', () => {
    // Mirrors the requiredFeature props in AppSidebar. If a route gains or
    // loses a gate there, this is the reminder to match it here — otherwise
    // the keyboard reaches somewhere the mouse cannot.
    const gated = NAV_CHORDS.filter((c) => c.requiredFeature !== undefined).map((c) => c.path);

    expect(gated.sort()).toEqual(
      ['/anomalies', '/bulk-delete', '/cache-proposals', '/key-analytics'].sort(),
    );
  });
});
