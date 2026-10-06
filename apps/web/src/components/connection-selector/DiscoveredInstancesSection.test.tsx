import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { DiscoveredInstance } from '@betterdb/shared';
import { DiscoveredInstancesSection } from './DiscoveredInstancesSection';

const now = Date.now();
const instance: DiscoveredInstance = {
  host: 'cache.internal',
  port: 6379,
  suggestedName: 'orders-cache',
  dbSystem: 'valkey',
  version: '8.1.0',
  firstSeenAt: now - 60_000,
  lastSeenAt: now - 60_000,
  droppedPoints: 12,
};

describe('DiscoveredInstancesSection', () => {
  it('renders nothing without instances', () => {
    const { container } = render(<DiscoveredInstancesSection instances={[]} onRegister={vi.fn()} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is collapsed by default and expands to show rows', () => {
    render(<DiscoveredInstancesSection instances={[instance]} onRegister={vi.fn()} onDismiss={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: /1 discovered via OTLP/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('orders-cache')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText('orders-cache')).toBeInTheDocument();
    expect(screen.getByText('cache.internal:6379')).toBeInTheDocument();
    expect(screen.getByText('Valkey 8.1.0')).toBeInTheDocument();
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('shows the bare version when the database system is unknown', () => {
    render(
      <DiscoveredInstancesSection
        instances={[{ ...instance, dbSystem: undefined }]}
        onRegister={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /discovered via OTLP/ }));
    expect(screen.getByText('8.1.0')).toBeInTheDocument();
  });

  it('calls register and dismiss with the instance', () => {
    const onRegister = vi.fn();
    const onDismiss = vi.fn();
    render(<DiscoveredInstancesSection instances={[instance]} onRegister={onRegister} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /discovered via OTLP/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Register orders-cache' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss orders-cache' }));
    expect(onRegister).toHaveBeenCalledWith(instance);
    expect(onDismiss).toHaveBeenCalledWith(instance);
  });

  it('renders untrusted names as text', () => {
    render(
      <DiscoveredInstancesSection
        instances={[{ ...instance, suggestedName: '<img src=x onerror=alert(1)>' }]}
        onRegister={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /discovered via OTLP/ }));
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows a dismiss error', () => {
    render(
      <DiscoveredInstancesSection
        instances={[instance]}
        onRegister={vi.fn()}
        onDismiss={vi.fn()}
        error="Too many dismissed instances"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Too many dismissed instances');
  });
});
