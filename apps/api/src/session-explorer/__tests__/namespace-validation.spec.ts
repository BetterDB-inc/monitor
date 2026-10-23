import { validateNamespaceInput } from '../namespace-validation';

const valid = {
  name: 'Chat history',
  pattern: 'message_store:*',
  preset: 'langchain-community',
  customSchema: null,
  oversizeThresholdBytes: 1048576,
};

const errorsOf = (input: unknown): string[] => {
  const result = validateNamespaceInput(input);
  return result.ok ? [] : result.errors;
};

describe('validateNamespaceInput', () => {
  it('accepts a valid input and trims the name', () => {
    const result = validateNamespaceInput({ ...valid, name: '  Chat history  ' });
    expect(result).toEqual({ ok: true, value: valid });
  });

  it('defaults the oversize threshold when omitted', () => {
    const { oversizeThresholdBytes: _omit, ...rest } = valid;
    const result = validateNamespaceInput(rest);
    expect(result.ok && result.value.oversizeThresholdBytes).toBe(1048576);
  });

  it.each(['*', '**', '?*', '[a]*', ''])('rejects bare wildcard pattern %p', (pattern) => {
    expect(errorsOf({ ...valid, pattern })).toContain('Pattern must include a literal prefix');
  });

  it.each(['app:*', 'message_store:*', 'a*'])('accepts pattern %p', (pattern) => {
    expect(errorsOf({ ...valid, pattern })).toEqual([]);
  });

  it('accepts an escaped star as a literal prefix', () => {
    expect(errorsOf({ ...valid, pattern: '\\*abc' })).toEqual([]);
  });

  it('trims the pattern and rejects inner whitespace', () => {
    const result = validateNamespaceInput({ ...valid, pattern: '  app:*  ' });
    expect(result.ok && result.value.pattern).toBe('app:*');
    expect(errorsOf({ ...valid, pattern: 'app: *' })).toContain('Pattern must not contain whitespace');
  });

  it('rejects a name over 200 characters and a pattern over 1024', () => {
    expect(errorsOf({ ...valid, name: 'n'.repeat(201) })).toEqual([
      'Name must be at most 200 characters',
    ]);
    expect(errorsOf({ ...valid, pattern: `p${'x'.repeat(1024)}` })).toEqual([
      'Pattern must be at most 1024 characters',
    ]);
    expect(errorsOf({ ...valid, name: 'n'.repeat(200), pattern: `p${'x'.repeat(1023)}` })).toEqual([]);
  });

  it('rejects an empty name', () => {
    expect(errorsOf({ ...valid, name: '   ' })).toContain('Name is required');
  });

  it.each([0, -1, 1.5, '10', 1e300])('rejects threshold %p', (oversizeThresholdBytes) => {
    expect(errorsOf({ ...valid, oversizeThresholdBytes })).toContain(
      'Oversize threshold must be a positive integer',
    );
  });

  it('rejects custom preset without a schema', () => {
    expect(errorsOf({ ...valid, preset: 'custom', customSchema: null })).toContain(
      'Custom preset requires a schema',
    );
  });

  it('surfaces custom schema errors', () => {
    const errors = errorsOf({ ...valid, preset: 'custom', customSchema: { nope: true } });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts a valid custom schema', () => {
    const customSchema = {
      valueType: 'list',
      messages: { from: 'items' },
      fields: { role: 'type', content: 'data.content' },
    };
    const result = validateNamespaceInput({ ...valid, preset: 'custom', customSchema });
    expect(result.ok && result.value.customSchema).toEqual(customSchema);
  });

  it('rejects an unknown preset', () => {
    expect(errorsOf({ ...valid, preset: 'mystery' })).toContain('Unknown preset');
  });

  it('drops the schema for non-custom presets', () => {
    const result = validateNamespaceInput({ ...valid, customSchema: { anything: 1 } });
    expect(result.ok && result.value.customSchema).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(errorsOf(null)).toEqual(['Body must be an object']);
  });
});
