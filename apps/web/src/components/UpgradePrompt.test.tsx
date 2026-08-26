import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { UpgradePrompt } from './UpgradePrompt';
import type { PaymentRequiredError } from '../api/client';

const error = {
  requiredTier: 'Pro or Enterprise',
  currentTier: 'community',
  message: 'This feature requires a Pro or Enterprise license',
} as unknown as PaymentRequiredError;

function renderAt(path: string, onDismiss = vi.fn()) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Back />
      <Routes>
        <Route path="/" element={<div>dashboard</div>} />
        <Route path="/anomalies" element={<UpgradePrompt error={error} onDismiss={onDismiss} />} />
      </Routes>
    </MemoryRouter>,
  );
  return onDismiss;
}

function Back() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>back</button>;
}

describe('UpgradePrompt', () => {
  it('sends the user to the dashboard when they decline', async () => {
    // Dismissing used to leave them on the gated route with a blank page, and
    // the next interaction raised the same prompt again — an inescapable loop.
    renderAt('/anomalies');

    fireEvent.click(screen.getByText('Maybe Later'));

    expect(await screen.findByText('dashboard')).toBeInTheDocument();
  });

  it('sends the user to the dashboard when they close it', () => {
    renderAt('/anomalies');

    fireEvent.click(screen.getByLabelText('Close'));

    expect(screen.getByText('dashboard')).toBeInTheDocument();
  });

  it('keeps the refused route out of history', async () => {
    // Pushing left the gated route one Back press away, where the next request
    // raised the same prompt again — the loop this was meant to close.
    renderAt('/anomalies');

    fireEvent.click(screen.getByText('Maybe Later'));
    await screen.findByText('dashboard');
    fireEvent.click(screen.getByText('back'));

    expect(screen.queryByText('Upgrade Required')).not.toBeInTheDocument();
  });

  it('still clears the prompt state so it does not reopen', () => {
    const onDismiss = renderAt('/anomalies');

    fireEvent.click(screen.getByText('Maybe Later'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
