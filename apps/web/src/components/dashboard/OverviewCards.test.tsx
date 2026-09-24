import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OverviewCards } from './OverviewCards';
import type { InfoResponse } from '../../types/metrics';

function uptimeCard(): HTMLElement {
  const card = screen.getByText('Uptime').closest('.min-w-\\[180px\\]');
  if (!(card instanceof HTMLElement)) {
    throw new Error('Uptime card not found');
  }
  return card;
}

describe('OverviewCards uptime', () => {
  it('renders days and hours when the server reports uptime', () => {
    const info = {
      server: { redis_version: '7.2.4', uptime_in_days: '3', uptime_in_seconds: '277200' },
    } as unknown as InfoResponse;

    render(<OverviewCards info={info} />);

    expect(uptimeCard()).toHaveTextContent('3d');
    expect(uptimeCard()).toHaveTextContent('5h');
  });

  it('renders the empty placeholder when the server section has no uptime', () => {
    const info = { server: { redis_version: '7.2.4' } } as unknown as InfoResponse;

    render(<OverviewCards info={info} />);

    expect(uptimeCard()).toHaveTextContent('-');
    expect(uptimeCard()).not.toHaveTextContent('undefined');
    expect(uptimeCard()).not.toHaveTextContent('NaN');
  });
});
