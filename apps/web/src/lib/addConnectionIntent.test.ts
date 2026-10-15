import { describe, it, expect, vi } from 'vitest';
import {
  openAddConnection,
  consumePendingAddConnection,
  OPEN_ADD_CONNECTION_EVENT,
} from './addConnectionIntent';

describe('addConnectionIntent', () => {
  it('dispatches the event and stashes the request until consumed', () => {
    const spy = vi.fn();
    window.addEventListener(OPEN_ADD_CONNECTION_EVENT, spy);
    openAddConnection({ tab: 'valkey', valkeyMaxmemory: '1gb' });
    window.removeEventListener(OPEN_ADD_CONNECTION_EVENT, spy);

    expect(spy).toHaveBeenCalledOnce();
    // Survives for a dialog that mounts after the event fired (mobile).
    expect(consumePendingAddConnection()).toEqual({ tab: 'valkey', valkeyMaxmemory: '1gb' });
  });

  it('clears the stash after one read so a remount does not re-open it', () => {
    openAddConnection();
    expect(consumePendingAddConnection()).toEqual({});
    expect(consumePendingAddConnection()).toBeNull();
  });
});
