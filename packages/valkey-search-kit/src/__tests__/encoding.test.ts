import { describe, it, expect } from 'vitest';
import { encodeFloat32 } from '../encoding';

describe('encodeFloat32', () => {
  it('returns a Buffer with byteLength === vec.length * 4', () => {
    const vec = [1.0, 2.0, 3.0, 4.0];
    const buf = encodeFloat32(vec);
    expect(buf.byteLength).toBe(vec.length * 4);
  });

  it('writes little-endian Float32 values readable by readFloatLE', () => {
    const vec = [0.5, -1.25, 3.75];
    const buf = encodeFloat32(vec);
    expect(buf.readFloatLE(0)).toBeCloseTo(0.5, 6);
    expect(buf.readFloatLE(4)).toBeCloseTo(-1.25, 6);
    expect(buf.readFloatLE(8)).toBeCloseTo(3.75, 6);
  });

  it('returns an empty Buffer for an empty vector', () => {
    expect(encodeFloat32([]).byteLength).toBe(0);
  });
});
