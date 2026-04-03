import { parseCommandLine } from '../command-parser';

describe('parseCommandLine', () => {
  it('should parse a simple command', () => {
    expect(parseCommandLine('PING')).toEqual(['PING']);
  });

  it('should parse a command with arguments', () => {
    expect(parseCommandLine('SET foo bar')).toEqual(['SET', 'foo', 'bar']);
  });

  it('should parse double-quoted strings', () => {
    expect(parseCommandLine('SET "my key" "my value"')).toEqual(['SET', 'my key', 'my value']);
  });

  it('should parse single-quoted strings', () => {
    expect(parseCommandLine("SET 'my key' 'my value'")).toEqual(['SET', 'my key', 'my value']);
  });

  it('should handle escaped quotes inside double quotes', () => {
    expect(parseCommandLine('SET key "hello \\"world\\""')).toEqual([
      'SET',
      'key',
      'hello "world"',
    ]);
  });

  it('should parse mixed quoted and unquoted arguments', () => {
    expect(parseCommandLine('MSET k1 v1 "k 2" "v 2"')).toEqual([
      'MSET',
      'k1',
      'v1',
      'k 2',
      'v 2',
    ]);
  });

  it('should return empty array for empty input', () => {
    expect(parseCommandLine('')).toEqual([]);
  });

  it('should handle extra whitespace', () => {
    expect(parseCommandLine('  SET   foo   bar  ')).toEqual(['SET', 'foo', 'bar']);
  });

  it('should handle escaped backslashes inside quotes', () => {
    expect(parseCommandLine('SET key "val\\\\ue"')).toEqual(['SET', 'key', 'val\\ue']);
  });

  it('should handle unclosed quotes gracefully', () => {
    expect(parseCommandLine('SET "key value')).toEqual(['SET', 'key value']);
  });

  it('should handle whitespace-only input', () => {
    expect(parseCommandLine('   ')).toEqual([]);
  });
});
