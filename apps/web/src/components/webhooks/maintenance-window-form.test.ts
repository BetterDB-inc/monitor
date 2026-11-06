import { describe, it, expect } from 'vitest';
import { MAX_MAINTENANCE_WINDOW_MS, WebhookEventType } from '@betterdb/shared';
import { buildCreateRequest, INITIAL_FORM } from './maintenance-window-form';

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

describe('buildCreateRequest', () => {
  it('starts now and scopes to the selected connection by default', () => {
    expect(buildCreateRequest({ ...INITIAL_FORM, name: ' Upgrade ' }, 'conn-1', NOW)).toEqual({
      name: 'Upgrade',
      reason: null,
      connectionId: 'conn-1',
      events: [],
      endsAt: NOW + HOUR,
    });
  });

  it('covers every connection and passes the chosen events and reason', () => {
    expect(
      buildCreateRequest(
        {
          ...INITIAL_FORM,
          name: 'Drill',
          reason: ' CHG-9 ',
          allConnections: true,
          limitEvents: true,
          events: [WebhookEventType.FAILOVER_STARTED],
          durationMs: 2 * HOUR,
        },
        null,
        NOW,
      ),
    ).toEqual({
      name: 'Drill',
      reason: 'CHG-9',
      connectionId: null,
      events: [WebhookEventType.FAILOVER_STARTED],
      endsAt: NOW + 2 * HOUR,
    });
  });

  it('sends an explicit start for a scheduled window', () => {
    const startAt = new Date(NOW + 3 * HOUR);
    const local = `${startAt.getFullYear()}-${String(startAt.getMonth() + 1).padStart(2, '0')}-${String(startAt.getDate()).padStart(2, '0')}T${String(startAt.getHours()).padStart(2, '0')}:${String(startAt.getMinutes()).padStart(2, '0')}`;
    const request = buildCreateRequest({ ...INITIAL_FORM, name: 'Later', startMode: 'at', startAt: local }, 'conn-1', NOW);
    expect(request).toMatchObject({ startsAt: NOW + 3 * HOUR, endsAt: NOW + 4 * HOUR });
  });

  it('explains what is missing instead of sending a bad request', () => {
    expect(buildCreateRequest({ ...INITIAL_FORM, name: '  ' }, 'conn-1', NOW)).toBe('Give the window a name.');
    expect(buildCreateRequest({ ...INITIAL_FORM, name: 'x', startMode: 'at', startAt: '' }, 'conn-1', NOW)).toBe(
      'Pick a start time.',
    );
    expect(
      buildCreateRequest({ ...INITIAL_FORM, name: 'x', startMode: 'at', startAt: '2020-01-01T00:00' }, 'conn-1', NOW),
    ).toBe('The start time is in the past.');
    expect(
      buildCreateRequest({ ...INITIAL_FORM, name: 'x', durationMs: MAX_MAINTENANCE_WINDOW_MS + 1 }, 'conn-1', NOW),
    ).toBe('Pick a duration of up to 7 days.');
    expect(buildCreateRequest({ ...INITIAL_FORM, name: 'x', limitEvents: true }, 'conn-1', NOW)).toBe(
      'Pick at least one event, or silence all events.',
    );
    expect(buildCreateRequest({ ...INITIAL_FORM, name: 'x' }, null, NOW)).toBe('Select a connection first.');
  });
});
