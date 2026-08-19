import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HowItWorks } from '../HowItWorks';
import { MIGRATION_STEPS } from '../migration-steps';

// HowItWorks is now the opening screen only — MigrationPage renders it at step 0
// and swaps to StepRail after that, so the two no longer restate the same steps on
// one screen. It therefore has no currentStep prop and always shows the full set.
describe('HowItWorks', () => {
  it('explains every migration step', () => {
    render(<HowItWorks />);

    for (const step of MIGRATION_STEPS) {
      expect(screen.getByText(step.title)).toBeInTheDocument();
      expect(screen.getByText(step.body)).toBeInTheDocument();
    }
  });

  it('illustrates every step', () => {
    const { container } = render(<HowItWorks />);

    expect(container.querySelectorAll('svg')).toHaveLength(MIGRATION_STEPS.length);
  });

  it('renders one card per step', () => {
    render(<HowItWorks />);

    expect(screen.getAllByRole('listitem')).toHaveLength(MIGRATION_STEPS.length);
  });
});
