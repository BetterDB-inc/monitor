import { describe, it, expect } from 'vitest';
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
  it('a long name cannot push the action buttons out of the card', () => {
    const webhook = makeWebhook({ name: 'a'.repeat(300) });
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
});
