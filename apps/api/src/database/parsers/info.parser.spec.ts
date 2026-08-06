import { InfoParser } from './info.parser';

describe('InfoParser.parseKvLine', () => {
  it('parses comma-separated cmdstat-style lines', () => {
    const result = InfoParser.parseKvLine(
      'calls=100,usec=500,usec_per_call=5.00,rejected_calls=0,failed_calls=0',
      ',',
    );

    expect(result).toEqual({
      calls: '100',
      usec: '500',
      usec_per_call: '5.00',
      rejected_calls: '0',
      failed_calls: '0',
    });
  });

  it('parses space-separated CLIENT LIST-style lines', () => {
    const result = InfoParser.parseKvLine(
      'id=1 addr=127.0.0.1:6379 name=cli age=10',
      ' ',
    );

    expect(result).toEqual({
      id: '1',
      addr: '127.0.0.1:6379',
      name: 'cli',
      age: '10',
    });
  });

  it('preserves = inside values by splitting on the first = only', () => {
    expect(InfoParser.parseKvLine('cmd=eval script=a=b=c', ' ')).toEqual({
      cmd: 'eval',
      script: 'a=b=c',
    });
  });

  it('skips pairs without an = and pairs with an empty key', () => {
    expect(InfoParser.parseKvLine('orphan,calls=5,=nokey', ',')).toEqual({
      calls: '5',
    });
  });

  it('trims whitespace around keys and values', () => {
    expect(InfoParser.parseKvLine('  a = 1 , b = 2 ', ',')).toEqual({
      a: '1',
      b: '2',
    });
  });

  it('returns an empty object for empty or whitespace-only input', () => {
    expect(InfoParser.parseKvLine('', ',')).toEqual({});
  });
});

describe('InfoParser prototype-pollution guards', () => {
  it('parseKvLine drops __proto__ field names', () => {
    const result = InfoParser.parseKvLine('__proto__=x,keys=5', ',');

    expect(result).toEqual({ keys: '5' });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it('parse drops __proto__ section headers and keys', () => {
    const result = InfoParser.parse(
      '# __proto__\r\npolluted:1\r\n\r\n# Keyspace\r\n__proto__:x\r\ndb0:keys=1,expires=0,avg_ttl=0\r\n',
    );

    expect(result).toEqual({ keyspace: { db0: 'keys=1,expires=0,avg_ttl=0' } });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });
});
