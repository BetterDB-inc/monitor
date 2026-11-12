import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../api/client', () => ({ fetchApi: vi.fn() }));

import { fetchApi } from '../../api/client';
import type { ClusterNode } from '../../types/metrics';
import { AvailabilityZonesDialog } from './AvailabilityZonesDialog';

const fetchApiMock = vi.mocked(fetchApi);

function clusterNode(overrides: Partial<ClusterNode>): ClusterNode {
  return {
    id: 'a'.repeat(40),
    address: '10.0.0.1:7001@17001',
    flags: ['master'],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 1,
    linkState: 'connected',
    slots: [[0, 16383]],
    ...overrides,
  };
}

const nodes = [
  clusterNode({}),
  clusterNode({ id: 'b'.repeat(40), address: '10.0.0.2:7002@17002' }),
];

function renderDialog(overrides: Partial<Parameters<typeof AvailabilityZonesDialog>[0]> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    connectionId: 'conn-1',
    nodes,
    zones: { '10.0.0.1:7001': 'us-east-1a' },
    onSaved: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<AvailabilityZonesDialog {...props} />);
  return props;
}

function zoneInput(): HTMLTextAreaElement {
  return screen.getByLabelText('Node zones') as HTMLTextAreaElement;
}

describe('AvailabilityZonesDialog', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockResolvedValue({ success: true });
  });

  it('starts with one line per node and the configured zones', () => {
    renderDialog();

    expect(zoneInput().value).toBe('10.0.0.1:7001=us-east-1a\n10.0.0.2:7002=');
  });

  it('renders nothing while closed', () => {
    renderDialog({ open: false });

    expect(screen.queryByLabelText('Node zones')).not.toBeInTheDocument();
  });

  it('saves the edited map, then reports it and closes', async () => {
    const props = renderDialog();
    fireEvent.change(zoneInput(), {
      target: { value: '10.0.0.1:7001=us-east-1a\n10.0.0.2:7002=us-east-1b' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
    expect(fetchApiMock).toHaveBeenCalledWith('/connections/conn-1/availability-zones', {
      method: 'PATCH',
      body: JSON.stringify({
        zones: { '10.0.0.1:7001': 'us-east-1a', '10.0.0.2:7002': 'us-east-1b' },
      }),
    });
    expect(props.onSaved).toHaveBeenCalledTimes(1);
  });

  it('clears the map when every zone is removed', async () => {
    const props = renderDialog();
    fireEvent.change(zoneInput(), { target: { value: '10.0.0.1:7001=\n10.0.0.2:7002=' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
    expect(fetchApiMock).toHaveBeenCalledWith('/connections/conn-1/availability-zones', {
      method: 'PATCH',
      body: JSON.stringify({ zones: {} }),
    });
  });

  it('shows which line is wrong and sends nothing', () => {
    const props = renderDialog();
    fireEvent.change(zoneInput(), { target: { value: '10.0.0.1=us-east-1a' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      "Line 1: Invalid node address '10.0.0.1': expected host:port",
    );
    expect(fetchApiMock).not.toHaveBeenCalled();
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it('shows a server rejection and stays open', async () => {
    fetchApiMock.mockRejectedValueOnce(new Error("Connection 'conn-1' not found."));
    const props = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent("Connection 'conn-1' not found.");
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it('closes from the Close button while nothing is being saved', () => {
    const props = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cannot be dismissed while a save is pending', async () => {
    let finish!: () => void;
    fetchApiMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = () => resolve({ success: true });
      }),
    );
    const props = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(zoneInput(), { key: 'Escape' });

    expect(props.onOpenChange).not.toHaveBeenCalled();

    finish();
    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
    expect(props.onOpenChange).toHaveBeenCalledTimes(1);
  });

  it('starts again from the stored zones when reopened', () => {
    const props = {
      onOpenChange: vi.fn(),
      connectionId: 'conn-1',
      nodes,
      zones: { '10.0.0.1:7001': 'us-east-1a' },
      onSaved: vi.fn(),
    };
    const { rerender } = render(<AvailabilityZonesDialog {...props} open />);
    fireEvent.change(zoneInput(), { target: { value: 'discarded edit' } });

    rerender(<AvailabilityZonesDialog {...props} open={false} />);
    rerender(<AvailabilityZonesDialog {...props} open />);

    expect(zoneInput().value).toBe('10.0.0.1:7001=us-east-1a\n10.0.0.2:7002=');
  });
});
