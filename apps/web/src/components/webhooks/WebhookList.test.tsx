import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WebhookList } from './WebhookList';
import type { Webhook } from '../../types/webhooks';

function makeWebhook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id: 'wh-1',
    name: 'Production Alerts',
    url: 'https://example.com/hooks/incoming',
    enabled: true,
    events: ['instance.health'] as Webhook['events'],
    retryPolicy: { maxRetries: 3, initialDelayMs: 1000 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

const noop = () => {};

describe('WebhookList', () => {
  it('does not render the webhook URL in the card (#450)', () => {
    const webhook = makeWebhook({ url: 'https://example.com/very/specific/endpoint' });
    render(
      <WebhookList webhooks={[webhook]} onEdit={noop} onDelete={noop} onTest={noop} onViewDeliveries={noop} />,
    );

    expect(screen.queryByText(/URL:/)).toBeNull();
    expect(screen.queryByText(webhook.url)).toBeNull();
  });

  it('keeps the action buttons on a shrink-safe row so a long URL cannot push them out (#449)', () => {
    // A single unbroken token (no slashes/whitespace) is what defeats normal
    // text wrapping and used to blow out the card's flex row.
    const longUrl = `https://example.com/${'a'.repeat(300)}`;
    const webhook = makeWebhook({ name: 'a'.repeat(300), url: longUrl });
    const { container } = render(
      <WebhookList webhooks={[webhook]} onEdit={noop} onDelete={noop} onTest={noop} onViewDeliveries={noop} />,
    );

    const actionsRow = screen.getByRole('button', { name: 'Test' }).parentElement;
    expect(actionsRow).toHaveClass('flex-shrink-0');

    const contentColumn = container.querySelector('.flex-1');
    expect(contentColumn).toHaveClass('min-w-0');

    expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deliveries' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('still renders name, status, events and retry policy', () => {
    const webhook = makeWebhook({
      name: 'Ops Notifications',
      events: ['instance.health', 'memory.alert'] as Webhook['events'],
    });
    render(
      <WebhookList webhooks={[webhook]} onEdit={noop} onDelete={noop} onTest={noop} onViewDeliveries={noop} />,
    );

    expect(screen.getByText('Ops Notifications')).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('instance.health')).toBeInTheDocument();
    expect(screen.getByText('memory.alert')).toBeInTheDocument();
    expect(screen.getByText(/Max 3 retries/)).toBeInTheDocument();
  });

  it('wires up the action callbacks', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onTest = vi.fn();
    const onViewDeliveries = vi.fn();
    const webhook = makeWebhook();
    render(
      <WebhookList
        webhooks={[webhook]}
        onEdit={onEdit}
        onDelete={onDelete}
        onTest={onTest}
        onViewDeliveries={onViewDeliveries}
      />,
    );

    screen.getByRole('button', { name: 'Test' }).click();
    screen.getByRole('button', { name: 'Deliveries' }).click();
    screen.getByRole('button', { name: 'Edit' }).click();
    screen.getByRole('button', { name: 'Delete' }).click();

    expect(onTest).toHaveBeenCalledWith(webhook);
    expect(onViewDeliveries).toHaveBeenCalledWith(webhook);
    expect(onEdit).toHaveBeenCalledWith(webhook);
    expect(onDelete).toHaveBeenCalledWith(webhook);
  });

  it('shows an empty state with no webhooks', () => {
    render(<WebhookList webhooks={[]} onEdit={noop} onDelete={noop} onTest={noop} onViewDeliveries={noop} />);
    expect(screen.getByText('No webhooks configured')).toBeInTheDocument();
  });
});
