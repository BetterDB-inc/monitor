import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionExplorerEmptyState } from '../EmptyState';

describe('SessionExplorerEmptyState', () => {
  it('renders the verbatim empty-state copy', () => {
    render(<SessionExplorerEmptyState onCreate={vi.fn()} />);
    expect(
      screen.getByText('BetterDB reads session state only from Valkey keys you point it at'),
    ).toBeInTheDocument();
  });

  it('offers to add a namespace', () => {
    const onCreate = vi.fn();
    render(<SessionExplorerEmptyState onCreate={onCreate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add namespace' }));
    expect(onCreate).toHaveBeenCalled();
  });
});
