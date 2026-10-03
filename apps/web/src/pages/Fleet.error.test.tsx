import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError, ExternalConnectionUnsupportedError } from '../api/client';
import { Fleet } from './Fleet';

const mockUsePolling = vi.fn();
vi.mock('../hooks/usePolling', () => ({ usePolling: (options: unknown) => mockUsePolling(options) }));
vi.mock('../hooks/useConnection', () => ({ useConnection: () => ({ setConnection: vi.fn() }) }));

function renderFleet() {
  render(
    <MemoryRouter>
      <Fleet />
    </MemoryRouter>,
  );
}

describe('Fleet error rendering', () => {
  beforeEach(() => {
    mockUsePolling.mockReset();
  });

  it('renders the live connection empty state for an unsupported error', () => {
    mockUsePolling.mockReturnValue({
      data: null,
      error: new ExternalConnectionUnsupportedError('getFleetSummary'),
      loading: false,
      refresh: vi.fn(),
    });

    renderFleet();

    expect(screen.getByText('Live connection required')).toBeTruthy();
    expect(screen.queryByText(/Failed to load fleet summary/)).toBeNull();
  });

  it('keeps the generic failure message for other errors', () => {
    mockUsePolling.mockReturnValue({
      data: null,
      error: new ApiError('boom', 500),
      loading: false,
      refresh: vi.fn(),
    });

    renderFleet();

    expect(screen.getByText(/Failed to load fleet summary: boom/)).toBeTruthy();
  });
});
