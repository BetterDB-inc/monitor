from __future__ import annotations

import struct


def encode_float32(vec: list[float]) -> bytes:
    """Encode a float list as little-endian Float32 bytes.

    Used to store embeddings as binary HSET field values for KNN search.
    """
    return struct.pack(f"<{len(vec)}f", *vec)


def decode_float32(data: bytes) -> list[float]:
    """Decode little-endian Float32 bytes into a float list."""
    n = len(data) // 4
    return list(struct.unpack_from(f"<{n}f", data))
