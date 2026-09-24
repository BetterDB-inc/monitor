import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { apiUrl } from '../../api/client';
import { BrokerButtons } from './BrokerButtons';

const { authState } = vi.hoisted(() => {
  return {
    authState: {
      brokerEnabled: false,
    },
  };
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => authState,
}));

describe('BrokerButtons', () => {
  it('renders nothing when the broker is disabled', () => {
    authState.brokerEnabled = false;
    const { container } = render(<BrokerButtons />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders Google and GitHub sign-in links when the broker is enabled', () => {
    authState.brokerEnabled = true;
    render(<BrokerButtons />);
    expect(screen.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute(
      'href',
      apiUrl('/auth/broker/start?provider=google'),
    );
    expect(screen.getByRole('link', { name: 'Continue with GitHub' })).toHaveAttribute(
      'href',
      apiUrl('/auth/broker/start?provider=github'),
    );
  });

  it('appends the invite token and next path when given', () => {
    authState.brokerEnabled = true;
    render(<BrokerButtons invite="tok-1" next="/settings" />);
    expect(screen.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute(
      'href',
      apiUrl('/auth/broker/start?provider=google&invite=tok-1&next=%2Fsettings'),
    );
    expect(screen.getByRole('link', { name: 'Continue with GitHub' })).toHaveAttribute(
      'href',
      apiUrl('/auth/broker/start?provider=github&invite=tok-1&next=%2Fsettings'),
    );
  });
});
