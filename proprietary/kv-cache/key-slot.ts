const SLOT_COUNT = 16384;

function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function hashTag(key: string): string {
  const open = key.indexOf('{');
  if (open === -1) return key;
  const close = key.indexOf('}', open + 1);
  return close > open + 1 ? key.slice(open + 1, close) : key;
}

export function keySlot(key: string): number {
  return crc16(Buffer.from(hashTag(key), 'utf8')) % SLOT_COUNT;
}

export type SlotOwnership = (slot: number) => boolean;

export function slotOwner(ranges: number[][]): SlotOwnership {
  return (slot) => ranges.some((range) => slot >= range[0] && slot <= range[range.length - 1]);
}
