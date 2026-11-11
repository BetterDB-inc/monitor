import {
  MAX_AVAILABILITY_ZONE_LENGTH,
  MAX_NODE_AVAILABILITY_ZONES,
  normalizeNodeAvailabilityZones,
  parseNodeAvailabilityZones,
} from '@betterdb/shared';

describe('normalizeNodeAvailabilityZones', () => {
  it('accepts a host:port to zone map', () => {
    expect(
      normalizeNodeAvailabilityZones({
        '10.0.0.1:7001': 'us-east-1a',
        'node-2.internal:7002': 'us-east-1b',
      }),
    ).toEqual({
      ok: true,
      zones: { '10.0.0.1:7001': 'us-east-1a', 'node-2.internal:7002': 'us-east-1b' },
    });
  });

  it('trims and lower-cases addresses and trims zones', () => {
    expect(normalizeNodeAvailabilityZones({ ' Node-1.Internal:7001 ': ' us-east-1a ' })).toEqual({
      ok: true,
      zones: { 'node-1.internal:7001': 'us-east-1a' },
    });
  });

  it('accepts IPv6 addresses with or without brackets', () => {
    expect(normalizeNodeAvailabilityZones({ '[::1]:7001': 'a', 'fe80::2:7002': 'b' })).toEqual({
      ok: true,
      zones: { '::1:7001': 'a', 'fe80::2:7002': 'b' },
    });
  });

  it('treats an empty map, null and undefined as no map', () => {
    expect(normalizeNodeAvailabilityZones({})).toEqual({ ok: true, zones: undefined });
    expect(normalizeNodeAvailabilityZones(null)).toEqual({ ok: true, zones: undefined });
    expect(normalizeNodeAvailabilityZones(undefined)).toEqual({ ok: true, zones: undefined });
  });

  it.each([
    ['a string', 'us-east-1a'],
    ['an array', [['10.0.0.1:7001', 'a']]],
    ['a number', 7],
  ])('rejects %s', (_, value) => {
    expect(normalizeNodeAvailabilityZones(value)).toEqual({
      ok: false,
      error: 'Availability zones must be an object of host:port to zone',
    });
  });

  it.each([
    '10.0.0.1',
    ':7001',
    '10.0.0.1:',
    '10.0.0.1:0',
    '10.0.0.1:65536',
    '10.0.0.1:70a1',
    'bad host:7001',
    '10.0.0.1:7001@17001',
  ])('rejects the address %p', (address) => {
    expect(normalizeNodeAvailabilityZones({ [address]: 'us-east-1a' })).toEqual({
      ok: false,
      error: `Invalid node address '${address}': expected host:port`,
    });
  });

  it('rejects a zone that is not a non-empty string', () => {
    expect(normalizeNodeAvailabilityZones({ '10.0.0.1:7001': '  ' })).toEqual({
      ok: false,
      error: "Availability zone for '10.0.0.1:7001' must be a non-empty string",
    });
    expect(normalizeNodeAvailabilityZones({ '10.0.0.1:7001': 3 })).toEqual({
      ok: false,
      error: "Availability zone for '10.0.0.1:7001' must be a non-empty string",
    });
  });

  it('rejects a zone that is too long or spans lines', () => {
    expect(
      normalizeNodeAvailabilityZones({
        '10.0.0.1:7001': 'z'.repeat(MAX_AVAILABILITY_ZONE_LENGTH + 1),
      }),
    ).toEqual({
      ok: false,
      error: `Availability zone for '10.0.0.1:7001' must be at most ${MAX_AVAILABILITY_ZONE_LENGTH} characters`,
    });
    expect(normalizeNodeAvailabilityZones({ '10.0.0.1:7001': 'us-east\n1a' })).toEqual({
      ok: false,
      error: "Availability zone for '10.0.0.1:7001' must be a single line",
    });
  });

  it('rejects a zone with an equals sign, which is what two merged lines look like', () => {
    expect(normalizeNodeAvailabilityZones({ '10.0.0.1:7001': 'rack-c10.0.0.2:7001=' })).toEqual({
      ok: false,
      error: "Availability zone for '10.0.0.1:7001' must not contain '='",
    });
  });

  it('rejects two addresses that normalise to the same node', () => {
    expect(normalizeNodeAvailabilityZones({ 'Node-1:7001': 'a', 'node-1:7001': 'b' })).toEqual({
      ok: false,
      error: "Duplicate node address 'node-1:7001'",
    });
  });

  it('rejects more entries than the limit', () => {
    const zones = Object.fromEntries(
      Array.from({ length: MAX_NODE_AVAILABILITY_ZONES + 1 }, (_, index) => [
        `10.0.${Math.floor(index / 250)}.${index % 250}:7001`,
        'a',
      ]),
    );

    expect(normalizeNodeAvailabilityZones(zones)).toEqual({
      ok: false,
      error: `At most ${MAX_NODE_AVAILABILITY_ZONES} nodes can be mapped to a zone`,
    });
  });
});

describe('parseNodeAvailabilityZones', () => {
  it('reads a stored JSON map', () => {
    expect(parseNodeAvailabilityZones('{"10.0.0.1:7001":"us-east-1a"}')).toEqual({
      '10.0.0.1:7001': 'us-east-1a',
    });
  });

  it('reads an already parsed map', () => {
    expect(parseNodeAvailabilityZones({ '10.0.0.1:7001': 'us-east-1a' })).toEqual({
      '10.0.0.1:7001': 'us-east-1a',
    });
  });

  it.each([null, undefined, '', '{}', 'not json', '[]', '{"10.0.0.1":"a"}'])(
    'reads %p as no map',
    (value) => {
      expect(parseNodeAvailabilityZones(value)).toBeUndefined();
    },
  );
});
