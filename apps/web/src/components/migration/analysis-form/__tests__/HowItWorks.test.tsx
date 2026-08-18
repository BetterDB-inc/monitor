import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HowItWorks } from '../HowItWorks';

describe('HowItWorks', () => {
  it('always explains all three steps', () => {
    render(<HowItWorks currentStep={2} />);

    expect(screen.getByText('Configure')).toBeInTheDocument();
    expect(screen.getByText('Analyse')).toBeInTheDocument();
    expect(screen.getByText('Migrate')).toBeInTheDocument();
  });

  it('illustrates each step only on the opening screen', () => {
    const { container, rerender } = render(<HowItWorks currentStep={0} />);
    expect(container.querySelectorAll('svg')).toHaveLength(3);

    rerender(<HowItWorks currentStep={1} />);
    expect(container.querySelectorAll('svg')).toHaveLength(0);
  });

  it('marks only the current step', () => {
    render(<HowItWorks currentStep={1} />);

    const steps = screen.getAllByRole('listitem');
    expect(steps).toHaveLength(3);
    expect(steps[0]).not.toHaveAttribute('aria-current');
    expect(steps[1]).toHaveAttribute('aria-current', 'step');
    expect(steps[2]).not.toHaveAttribute('aria-current');
  });

  it('moves the marker as the migration progresses', () => {
    const { rerender } = render(<HowItWorks currentStep={0} />);
    expect(screen.getAllByRole('listitem')[0]).toHaveAttribute('aria-current', 'step');

    rerender(<HowItWorks currentStep={2} />);
    const steps = screen.getAllByRole('listitem');
    expect(steps[0]).not.toHaveAttribute('aria-current');
    expect(steps[2]).toHaveAttribute('aria-current', 'step');
  });
});
