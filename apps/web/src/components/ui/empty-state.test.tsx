import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Server } from 'lucide-react';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('renders a bordered card with a heading by default', () => {
    const { container } = render(
      <EmptyState title="Nothing here" description="Add something" action={<button>Add</button>} />,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Nothing here' })).toBeInTheDocument();
    expect(screen.getByText('Add something')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass('border', 'p-8');
  });

  it('renders without a card or heading in the inline variant', () => {
    const { container } = render(<EmptyState variant="inline" title="No rows" />);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByText('No rows')).toBeInTheDocument();
    expect(container.firstElementChild).not.toHaveClass('border');
    expect(container.firstElementChild).toHaveClass('py-8');
  });

  it('lets className override the inline padding', () => {
    const { container } = render(<EmptyState variant="inline" className="py-12" title="No rows" />);
    expect(container.firstElementChild).toHaveClass('py-12');
    expect(container.firstElementChild).not.toHaveClass('py-8');
  });

  it('renders the icon hidden from assistive tech', () => {
    const { container } = render(<EmptyState icon={Server} title="No nodes" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
