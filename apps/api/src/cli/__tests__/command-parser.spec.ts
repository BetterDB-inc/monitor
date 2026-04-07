import { parseCommandLine } from '../command-parser';

describe('parseCommandLine', () => {
  it.each([
    ['simple command', 'PING', ['PING']],
    ['command with arguments', 'SET foo bar', ['SET', 'foo', 'bar']],
    ['double-quoted strings', 'SET "my key" "my value"', ['SET', 'my key', 'my value']],
    ['single-quoted strings', "SET 'my key' 'my value'", ['SET', 'my key', 'my value']],
    ['escaped quotes inside double quotes', 'SET key "hello \\"world\\""', ['SET', 'key', 'hello "world"']],
    ['mixed quoted and unquoted', 'MSET k1 v1 "k 2" "v 2"', ['MSET', 'k1', 'v1', 'k 2', 'v 2']],
    ['empty input', '', []],
    ['extra whitespace', '  SET   foo   bar  ', ['SET', 'foo', 'bar']],
    ['escaped backslashes inside quotes', 'SET key "val\\\\ue"', ['SET', 'key', 'val\\ue']],
    ['unclosed quotes', 'SET "key value', ['SET', 'key value']],
    ['whitespace-only input', '   ', []],
  ])('should parse %s', (_label, input, expected) => {
    expect(parseCommandLine(input)).toEqual(expected);
  });
});
