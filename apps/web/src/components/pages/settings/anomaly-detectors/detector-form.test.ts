import { describe, expect, it } from 'vitest';
import type { AnomalyDetectorConfigEntry } from '@betterdb/shared';
import {
  buildSave,
  isCustomized,
  isDirty,
  summarize,
  toFormState,
  validateForm,
  type DetectorFormState,
} from './detector-form';

const connections: AnomalyDetectorConfigEntry = {
  warningZScore: 2,
  criticalZScore: 3,
  consecutiveRequired: 3,
  cooldownMs: 60000,
};

const fragmentation: AnomalyDetectorConfigEntry = {
  warningZScore: 2,
  criticalZScore: 3,
  warningAbsolute: 1.5,
  criticalAbsolute: 2,
  consecutiveRequired: 5,
  cooldownMs: 120000,
};

function emptyForm(): DetectorFormState {
  return toFormState(connections, connections);
}

describe('toFormState', () => {
  it('leaves fields equal to the default empty', () => {
    expect(toFormState(connections, connections)).toEqual({
      warningZScore: '',
      criticalZScore: '',
      warningAbsolute: { enabled: false, value: '' },
      criticalAbsolute: { enabled: false, value: '' },
      consecutiveRequired: '',
      cooldownSeconds: '',
    });
  });

  it('shows values that differ from the default', () => {
    const form = toFormState({ ...connections, warningZScore: 2.5, cooldownMs: 90000 }, connections);
    expect(form.warningZScore).toBe('2.5');
    expect(form.cooldownSeconds).toBe('90');
  });

  it('marks an absolute threshold enabled when it is present', () => {
    const form = toFormState({ ...connections, warningAbsolute: 1000 }, connections);
    expect(form.warningAbsolute).toEqual({ enabled: true, value: '1000' });
  });

  it('keeps a default absolute threshold enabled but empty', () => {
    const form = toFormState(fragmentation, fragmentation);
    expect(form.warningAbsolute).toEqual({ enabled: true, value: '' });
  });

  it('marks an absolute threshold disabled when it is absent from resolved', () => {
    const { criticalAbsolute: _omit, ...withoutCrit } = fragmentation;
    expect(toFormState(withoutCrit, fragmentation).criticalAbsolute).toEqual({
      enabled: false,
      value: '',
    });
  });
});

describe('buildSave', () => {
  it('resets when every field equals the default', () => {
    expect(buildSave(emptyForm(), connections)).toEqual({ kind: 'reset' });
  });

  it('sends all six fields with defaults filled in', () => {
    const form = { ...emptyForm(), warningZScore: '2.5' };
    expect(buildSave(form, connections)).toEqual({
      kind: 'patch',
      entry: {
        warningZScore: 2.5,
        criticalZScore: 3,
        warningAbsolute: 0,
        criticalAbsolute: 0,
        consecutiveRequired: 3,
        cooldownMs: 60000,
      },
    });
  });

  it('sends 0 for an absolute threshold toggled off', () => {
    const form = toFormState(fragmentation, fragmentation);
    form.criticalAbsolute = { enabled: false, value: '' };
    const save = buildSave(form, fragmentation);
    expect(save).toEqual({
      kind: 'patch',
      entry: expect.objectContaining({ warningAbsolute: 1.5, criticalAbsolute: 0 }),
    });
  });

  it('converts cooldown seconds to milliseconds', () => {
    const form = { ...emptyForm(), cooldownSeconds: '90' };
    expect(buildSave(form, connections)).toEqual({
      kind: 'patch',
      entry: expect.objectContaining({ cooldownMs: 90000 }),
    });
  });

  it('resets when a typed value equals the default', () => {
    const form = { ...emptyForm(), warningZScore: '2' };
    expect(buildSave(form, connections)).toEqual({ kind: 'reset' });
  });
});

describe('validateForm', () => {
  it('accepts an empty form', () => {
    expect(validateForm(emptyForm(), connections)).toEqual({});
  });

  it('rejects an enabled absolute threshold with no value and no default', () => {
    const form = { ...emptyForm(), warningAbsolute: { enabled: true, value: '' } };
    expect(validateForm(form, connections)).toEqual({
      warningAbsolute: 'Enter a value or turn this threshold off',
    });
  });

  it('rejects a warning z-score out of range', () => {
    const form = { ...emptyForm(), warningZScore: '20' };
    expect(validateForm(form, connections).warningZScore).toBe('Must be between 0.5 and 10');
  });

  it('rejects a critical z-score not above warning', () => {
    const form = { ...emptyForm(), warningZScore: '4', criticalZScore: '3' };
    expect(validateForm(form, connections).criticalZScore).toBe(
      'Must be greater than the warning z-score',
    );
  });

  it('rejects a critical absolute not above warning absolute', () => {
    const form = {
      ...emptyForm(),
      warningAbsolute: { enabled: true, value: '100' },
      criticalAbsolute: { enabled: true, value: '50' },
    };
    expect(validateForm(form, connections).criticalAbsolute).toBe(
      'Must be greater than the warning threshold',
    );
  });

  it('rejects a negative absolute threshold', () => {
    const form = { ...emptyForm(), warningAbsolute: { enabled: true, value: '-1' } };
    expect(validateForm(form, connections).warningAbsolute).toBe(
      'Must be greater than 0, or turn this threshold off',
    );
  });

  it('rejects 0 for an enabled absolute threshold because 0 means off', () => {
    const form = { ...emptyForm(), criticalAbsolute: { enabled: true, value: '0' } };
    expect(validateForm(form, connections).criticalAbsolute).toBe(
      'Must be greater than 0, or turn this threshold off',
    );
  });

  it('rejects a fractional consecutive count', () => {
    const form = { ...emptyForm(), consecutiveRequired: '2.5' };
    expect(validateForm(form, connections).consecutiveRequired).toBe(
      'Must be a whole number between 1 and 20',
    );
  });

  it('rejects a zero cooldown', () => {
    const form = { ...emptyForm(), cooldownSeconds: '0' };
    expect(validateForm(form, connections).cooldownSeconds).toBe(
      'Must be between 1 and 3600 seconds',
    );
  });

  it('rejects text that is not a number', () => {
    const form = { ...emptyForm(), warningZScore: 'abc' };
    expect(validateForm(form, connections).warningZScore).toBe('Must be between 0.5 and 10');
  });
});

describe('isCustomized', () => {
  it('is false when resolved equals defaults', () => {
    expect(isCustomized(fragmentation, fragmentation)).toBe(false);
  });

  it('is true when an absolute threshold was turned off', () => {
    const { criticalAbsolute: _omit, ...withoutCrit } = fragmentation;
    expect(isCustomized(withoutCrit, fragmentation)).toBe(true);
  });

  it('is true when a value differs', () => {
    expect(isCustomized({ ...connections, consecutiveRequired: 4 }, connections)).toBe(true);
  });
});

describe('summarize', () => {
  it('lists values in order and flags customized ones', () => {
    const segments = summarize(
      { ...connections, warningZScore: 2.5, warningAbsolute: 1000 },
      connections,
    );
    expect(segments.map((s) => s.text)).toEqual(['z 2.5 / 3', 'warn >1000', 'crit off', '3×', '60s']);
    expect(segments.map((s) => s.customized)).toEqual([true, true, false, false, false]);
  });
});

describe('isDirty', () => {
  it('detects a changed field', () => {
    expect(isDirty({ ...emptyForm(), warningZScore: '2.5' }, emptyForm())).toBe(true);
    expect(isDirty(emptyForm(), emptyForm())).toBe(false);
  });
});
