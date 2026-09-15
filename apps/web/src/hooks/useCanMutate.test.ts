import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const useAuthMock = vi.fn();
vi.mock('../contexts/AuthContext', () => {
  return {
    useAuth: () => {
      return useAuthMock();
    },
  };
});

import { useCanMutate } from './useCanMutate';

describe('useCanMutate', () => {
  it('is true when the workspace is disabled or cloud', () => {
    useAuthMock.mockReturnValue({ mode: 'disabled', user: null });
    expect(renderHook(() => useCanMutate()).result.current).toBe(true);
    useAuthMock.mockReturnValue({ mode: 'cloud', user: null });
    expect(renderHook(() => useCanMutate()).result.current).toBe(true);
  });

  it('is true for self-hosted admins and owners', () => {
    useAuthMock.mockReturnValue({ mode: 'self-hosted', user: { role: 'admin', isOwner: false } });
    expect(renderHook(() => useCanMutate()).result.current).toBe(true);
  });

  it('is false for self-hosted members and for no user', () => {
    useAuthMock.mockReturnValue({ mode: 'self-hosted', user: { role: 'member', isOwner: false } });
    expect(renderHook(() => useCanMutate()).result.current).toBe(false);
    useAuthMock.mockReturnValue({ mode: 'self-hosted', user: null });
    expect(renderHook(() => useCanMutate()).result.current).toBe(false);
  });
});
