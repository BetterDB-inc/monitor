import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useConnectionDialog } from './useConnectionDialog';

function renderDialogState(initial: string | undefined) {
  return renderHook(({ connectionId }) => useConnectionDialog(connectionId), {
    initialProps: { connectionId: initial },
  });
}

describe('useConnectionDialog', () => {
  it('opens and closes for the current connection', () => {
    const { result } = renderDialogState('conn-a');
    expect(result.current.open).toBe(false);

    act(() => result.current.onOpenChange(true));
    expect(result.current.open).toBe(true);

    act(() => result.current.onOpenChange(false));
    expect(result.current.open).toBe(false);
  });

  it('closes when the connection changes', () => {
    const { result, rerender } = renderDialogState('conn-a');
    act(() => result.current.onOpenChange(true));

    rerender({ connectionId: 'conn-b' });

    expect(result.current.open).toBe(false);
  });

  it('stays closed when the first connection is selected again', () => {
    const { result, rerender } = renderDialogState('conn-a');
    act(() => result.current.onOpenChange(true));

    rerender({ connectionId: 'conn-b' });
    rerender({ connectionId: 'conn-a' });

    expect(result.current.open).toBe(false);
  });

  it('ignores a close that belongs to an earlier connection', () => {
    const { result, rerender } = renderDialogState('conn-a');
    act(() => result.current.onOpenChange(true));
    const closeForFirstConnection = result.current.onOpenChange;
    rerender({ connectionId: 'conn-b' });
    act(() => result.current.onOpenChange(true));

    act(() => closeForFirstConnection(false));

    expect(result.current.open).toBe(true);
  });

  it('stays closed with no connection', () => {
    const { result } = renderDialogState(undefined);

    act(() => result.current.onOpenChange(true));

    expect(result.current.open).toBe(false);
  });
});
