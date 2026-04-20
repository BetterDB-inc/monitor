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
