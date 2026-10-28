import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PAGERDUTY_EVENTS_URL, Tier, WebhookPayloadFormat } from '@betterdb/shared';
import type { Webhook } from '../../types/webhooks';

const { getStatus } = vi.hoisted(() => ({ getStatus: vi.fn() }));
vi.mock('../../api/license', () => ({ licenseApi: { getStatus } }));

import { WebhookForm } from './WebhookForm';

const ROUTING_KEY = 'R0123456789ABCDEFGHIJKLMNOPQRSTU';

function existing(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id: 'wh-1',
    name: 'Pager',
    url: PAGERDUTY_EVENTS_URL,
    secret: 'whsec_abcd***',
    enabled: true,
    events: ['instance.down'] as Webhook['events'],
    headers: {},
    retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
    payloadFormat: WebhookPayloadFormat.PAGERDUTY,
    routingKey: 'R012***',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('WebhookForm incident formats', () => {
  beforeEach(() => {
    getStatus.mockResolvedValue({ tier: Tier.community });
  });

  it('lists the PagerDuty and Teams formats', async () => {
    render(<WebhookForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    const select = screen.getByLabelText('Payload format');
    const values = Array.from((select as HTMLSelectElement).options).map((option) => option.value);
    expect(values).toEqual(['generic', 'slack', 'discord', 'pagerduty', 'teams', 'google_chat']);
  });

  it('shows the integration key field only for PagerDuty and fills in the endpoint', async () => {
    render(<WebhookForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByLabelText(/Integration key/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Payload format'), { target: { value: 'pagerduty' } });

    expect(screen.getByLabelText(/Integration key/)).toBeRequired();
    expect(screen.getByPlaceholderText(PAGERDUTY_EVENTS_URL)).toHaveValue(PAGERDUTY_EVENTS_URL);
  });

  it('submits the trimmed routing key with the pagerduty format', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<WebhookForm onSubmit={onSubmit} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Instance Down')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('Production Alerts'), { target: { value: 'Pager' } });
    fireEvent.change(screen.getByLabelText('Payload format'), { target: { value: 'pagerduty' } });
    fireEvent.change(screen.getByLabelText(/Integration key/), { target: { value: `  ${ROUTING_KEY}  ` } });
    fireEvent.click(screen.getByText('Instance Down'));
    fireEvent.submit(screen.getByRole('button', { name: 'Create Webhook' }).closest('form')!);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      name: 'Pager',
      url: PAGERDUTY_EVENTS_URL,
      payloadFormat: 'pagerduty',
      routingKey: ROUTING_KEY,
    });
  });

  it('keeps the redacted key on edit so the stored key is not replaced', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<WebhookForm webhook={existing()} onSubmit={onSubmit} onCancel={vi.fn()} />);

    const keyInput = await screen.findByLabelText(/Integration key/);
    expect(keyInput).toHaveValue('R012***');
    expect(keyInput).not.toBeRequired();

    fireEvent.submit(screen.getByRole('button', { name: 'Update Webhook' }).closest('form')!);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ routingKey: 'R012***', secret: 'whsec_abcd***' });
  });

  it('asks for the recovery event when a PagerDuty webhook would leave incidents open', async () => {
    render(<WebhookForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Instance Down')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Payload format'), { target: { value: 'pagerduty' } });

    fireEvent.click(screen.getByText('Instance Down'));
    expect(screen.getByTestId('missing-resolvers')).toHaveTextContent('Also subscribe to Instance Up');

    fireEvent.click(screen.getByText('Instance Up'));
    expect(screen.queryByTestId('missing-resolvers')).not.toBeInTheDocument();
  });

  it('does not ask for recovery events on other formats', async () => {
    render(<WebhookForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Instance Down')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Instance Down'));
    expect(screen.queryByTestId('missing-resolvers')).not.toBeInTheDocument();
  });

  it('suggests the matching format for a Teams workflow URL', async () => {
    render(<WebhookForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('https://api.example.com/webhooks'), {
      target: { value: 'https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use teams format' }));
    expect(screen.getByLabelText('Payload format')).toHaveValue('teams');
  });
});
