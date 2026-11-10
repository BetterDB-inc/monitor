import { describe, expect, it } from 'vitest';
import { incidentEventPath } from '@betterdb/shared';
import { CONNECTION_PARAM } from '../../../lib/connectionParam';

describe('incidentEventPath', () => {
  it('builds the by-event path with time and connection', () => {
    const url = new URL(incidentEventPath('a/b', 1700000000000, 'conn 1'), 'http://x');

    expect(url.pathname).toBe('/anomalies/incidents/by-event/a%2Fb');
    expect(url.searchParams.get('at')).toBe('1700000000000');
    expect(url.searchParams.get(CONNECTION_PARAM)).toBe('conn 1');
  });

  it('leaves the connection out when there is none', () => {
    expect(incidentEventPath('a', 5)).toBe('/anomalies/incidents/by-event/a?at=5');
  });
});
