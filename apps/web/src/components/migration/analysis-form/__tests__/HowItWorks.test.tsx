import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HowItWorks } from '../HowItWorks';

function stepFor(title: string): HTMLElement {
  const heading = screen.getByText(title);
  const step = heading.closest('[class*="items-start"]');
  if (step === null) {
    throw new Error(`No step container found for ${title}`);
  }
  return step as HTMLElement;
}

describe('HowItWorks', () => {
  it('always explains all three steps', () => {
    render(<HowItWorks currentStep={2} />);

    expect(screen.getByText('Configure')).toBeInTheDocument();
    expect(screen.getByText('Analyse')).toBeInTheDocument();
    expect(screen.getByText('Migrate')).toBeInTheDocument();
  });

  it('marks only the current step', () => {
    render(<HowItWorks currentStep={1} />);

    expect(stepFor('Configure')).not.toHaveAttribute('aria-current');
    expect(stepFor('Analyse')).toHaveAttribute('aria-current', 'step');
    expect(stepFor('Migrate')).not.toHaveAttribute('aria-current');
  });

  it('moves the marker as the migration progresses', () => {
    const { rerender } = render(<HowItWorks currentStep={0} />);
    expect(stepFor('Configure')).toHaveAttribute('aria-current', 'step');

    rerender(<HowItWorks currentStep={2} />);
    expect(stepFor('Configure')).not.toHaveAttribute('aria-current');
    expect(stepFor('Migrate')).toHaveAttribute('aria-current', 'step');
  });
});
