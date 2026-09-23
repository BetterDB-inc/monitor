import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiveConnectionGuard } from './LiveConnectionGuard';

const mockUseConnection = vi.fn();
vi.mock('../hooks/useConnection', () => ({ useConnection: () => mockUseConnection() }));

describe('LiveConnectionGuard', () => {
  it('renders children for a direct connection', () => {
    mockUseConnection.mockReturnValue({ currentConnection: { id: 'a', connectionType: 'direct' } });
    render(<LiveConnectionGuard><p>page</p></LiveConnectionGuard>);
    expect(screen.getByText('page')).toBeTruthy();
  });

  it('renders the empty state for an external connection', () => {
    mockUseConnection.mockReturnValue({ currentConnection: { id: 'a', connectionType: 'external' } });
    render(<LiveConnectionGuard><p>page</p></LiveConnectionGuard>);
    expect(screen.queryByText('page')).toBeNull();
    expect(
      screen.getByText('Not available for OTLP-ingested connections — this view needs a live connection.'),
    ).toBeTruthy();
  });
});
