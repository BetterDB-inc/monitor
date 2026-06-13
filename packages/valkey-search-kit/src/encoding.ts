/**
 * Encode number[] as a little-endian Float32 Buffer.
 * Used to store embeddings as binary HSET field values.
 */
export function encodeFloat32(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i], i * 4);
  }
  return buf;
}
