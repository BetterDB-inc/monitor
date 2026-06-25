import struct

from betterdb_valkey_search_kit import decode_float32, encode_float32


def test_byte_length_is_four_per_element():
    vec = [1.0, 2.0, 3.0, 4.0]
    buf = encode_float32(vec)
    assert len(buf) == len(vec) * 4


def test_little_endian_float32_values():
    vec = [0.5, -1.25, 3.75]
    buf = encode_float32(vec)
    assert struct.unpack_from("<f", buf, 0)[0] == 0.5
    assert struct.unpack_from("<f", buf, 4)[0] == -1.25
    assert struct.unpack_from("<f", buf, 8)[0] == 3.75


def test_decode_inverts_encode():
    # These values are exactly representable in float32, so equality holds.
    vec = [0.5, -1.25, 3.75]
    assert decode_float32(encode_float32(vec)) == vec


def test_empty_vector():
    assert len(encode_float32([])) == 0
    assert decode_float32(b"") == []
