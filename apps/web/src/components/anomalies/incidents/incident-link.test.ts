import { describe, expect, it } from 'vitest';
import { incidentEventPath, incidentEventUrl } from '@betterdb/shared';
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

describe('incidentEventUrl', () => {
  const path = '/anomalies/incidents/by-event/ev%201?at=1000&connection=conn-1';

  it('joins the base URL and the event path', () => {
    expect(incidentEventUrl('https://m.example.com', 'ev 1', 1000, 'conn-1')).toBe(
      `https://m.example.com${path}`,
    );
  });

  it('drops a trailing slash from the base URL', () => {
    expect(incidentEventUrl('https://m.example.com/', 'ev 1', 1000, 'conn-1')).toBe(
      `https://m.example.com${path}`,
    );
  });

  it('keeps a path prefix of the base URL', () => {
    expect(incidentEventUrl('https://m.example.com/monitor/', 'ev 1', 1000, 'conn-1')).toBe(
      `https://m.example.com/monitor${path}`,
    );
  });

  it('leaves the connection out when there is none', () => {
    expect(incidentEventUrl('https://m.example.com', 'ev-1', 1000)).toBe(
      'https://m.example.com/anomalies/incidents/by-event/ev-1?at=1000',
    );
  });
});
