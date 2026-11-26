import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_PLACEMENT_SETTINGS, type PlacementSettings } from '@betterdb/shared';

const { canMutate } = vi.hoisted(() => ({ canMutate: vi.fn(() => true) }));
vi.mock('../../hooks/useCanMutate', () => ({ useCanMutate: canMutate }));

import { ApiError } from '../../api/client';
import { PlacementPolicyDrawer } from './PlacementPolicyDrawer';
import { formOf, settingsOf } from './placement-policy-form';

const stored: PlacementSettings = {
  ...DEFAULT_PLACEMENT_SETTINGS,
  triggerRatio: 3,
  maxCpuShare: 0.4,
  maintenanceWindows: [{ days: [1, 3], start: '02:00', durationMinutes: 120 }],
  excludedShardIds: ['node-a'],
  excludedSlots: [100, 101, 102, 5000],
};

function open(save = vi.fn(), onOpenChange = vi.fn()) {
  render(
    <PlacementPolicyDrawer
      open
      onOpenChange={onOpenChange}
      settings={stored}
      version={4}
      onSave={save}
    />,
  );
  return { save, onOpenChange };
}

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

describe('PlacementPolicyDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canMutate.mockReturnValue(true);
  });

  it('shows every field with its saved value', () => {
    open();
    expect(field('Trigger ratio').value).toBe('3');
    expect(field('Resolve ratio').value).toBe('1.25');
    expect(field('CPU share limit').value).toBe('0.4');
    expect(field('Network share limit').value).toBe('');
    expect(field('Node CPU limit (µs/s)').value).toBe('800000');
    expect(field('Sustain (minutes)').value).toBe('30');
    expect(field('Slot cooldown (days)').value).toBe('7');
    expect(field('No return (days)').value).toBe('7');
    expect(field('Moves per hour').value).toBe('4');
    expect(field('GiB moved per hour').value).toBe('2');
    expect(field('Maintenance windows').value).toBe('Mon,Wed 02:00 120');
    expect(field('Excluded shards').value).toBe('node-a');
    expect(field('Excluded slots').value).toBe('100-102, 5000');
    expect(field('Abort latency (ms)').value).toBe('50');
    expect(field('Verify (minutes)').value).toBe('10');
    expect(field('Verify tolerance').value).toBe('0.5');
    expect(screen.getByRole('switch', { name: 'Roll back worse moves' })).toBeChecked();
  });

  it('saves the edited policy at the version it was opened with and closes', async () => {
    const { save, onOpenChange } = open(vi.fn().mockResolvedValue(undefined));
    fireEvent.change(field('Trigger ratio'), { target: { value: '2.5' } });
    fireEvent.change(field('Excluded slots'), { target: { value: '7-8' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Roll back worse moves' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        { ...stored, triggerRatio: 2.5, excludedSlots: [7, 8], autoRollback: false },
        4,
      ),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('shows the errors the server gives and stays open', async () => {
    const save = vi.fn().mockRejectedValue(
      new ApiError('Invalid placement policy', 400, {
        message: 'Invalid placement policy',
        errors: ['resolveRatio: must be under triggerRatio'],
      }),
    );
    const { onOpenChange } = open(save);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'resolveRatio: must be under triggerRatio',
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('says the policy changed when the saved version moved on', async () => {
    open(
      vi
        .fn()
        .mockRejectedValue(
          new ApiError('stale', 409, { message: 'stale', reason: 'version_conflict' }),
        ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone saved the policy after you opened it',
    );
  });

  it('refuses a line it cannot read before asking the server', async () => {
    const { save } = open();
    fireEvent.change(field('Maintenance windows'), { target: { value: 'Mon 02:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Maintenance window 1');
    expect(save).not.toHaveBeenCalled();
  });

  it('shows the policy read-only to a member', () => {
    canMutate.mockReturnValue(false);
    open();
    expect(field('Trigger ratio')).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Roll back worse moves' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByText('Only an admin can change the policy.')).toBeInTheDocument();
  });
});

describe('placement policy form', () => {
  it('reads back the settings it shows', () => {
    expect(settingsOf(formOf(stored))).toEqual({ ok: true, settings: stored });
    expect(settingsOf(formOf(DEFAULT_PLACEMENT_SETTINGS))).toEqual({
      ok: true,
      settings: DEFAULT_PLACEMENT_SETTINGS,
    });
  });

  it('reads spaces around a range dash and drops repeated slots', () => {
    const form = formOf(stored);
    const result = settingsOf({ ...form, excludedSlots: '100 - 102, 101, 5000 5000' });
    expect(result).toEqual({
      ok: true,
      settings: { ...stored, excludedSlots: [100, 101, 102, 5000] },
    });
  });

  it('refuses a slot past 16383 and a field that is not a number', () => {
    const form = formOf(stored);
    const result = settingsOf({
      ...form,
      numbers: { ...form.numbers, sustainMinutes: 'soon' },
      excludedSlots: '16380-16384',
    });
    expect(result).toEqual({
      ok: false,
      errors: [expect.stringContaining('sustainMinutes'), expect.stringContaining('16380-16384')],
    });
  });
});
