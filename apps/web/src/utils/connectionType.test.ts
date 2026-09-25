import { describe, expect, it } from 'vitest';
import { connectionTypeSuffix, isExternalConnection } from './connectionType';

describe('connectionType', () => {
  it('detects external connections', () => {
    expect(isExternalConnection({ connectionType: 'external' })).toBe(true);
    expect(isExternalConnection({ connectionType: 'direct' })).toBe(false);
    expect(isExternalConnection(null)).toBe(false);
  });

  it('labels each connection type', () => {
    expect(connectionTypeSuffix({ connectionType: 'agent' })).toBe(' · via agent');
    expect(connectionTypeSuffix({ connectionType: 'external' })).toBe(' · OTLP push');
    expect(connectionTypeSuffix({ connectionType: 'direct' })).toBe(' · direct');
    expect(connectionTypeSuffix({})).toBe(' · direct');
  });
});
