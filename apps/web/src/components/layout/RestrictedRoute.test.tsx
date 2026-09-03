import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const useDemoStateMock = vi.fn();
vi.mock('../../contexts/DemoContext', () => {
  return {
    useDemoState: () => {
      return useDemoStateMock();
    },
  };
});

const useCanMutateMock = vi.fn();
vi.mock('../../hooks/useCanMutate', () => {
  return {
    useCanMutate: () => {
      return useCanMutateMock();
    },
  };
});

import { RestrictedRoute } from './RestrictedRoute';

function renderAtRestricted() {
  return render(
    <MemoryRouter initialEntries={['/restricted']}>
      <Routes>
        <Route path="/" element={<div>Home page</div>} />
        <Route
          path="/restricted"
          element={
            <RestrictedRoute>
              <div>Restricted content</div>
            </RestrictedRoute>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RestrictedRoute', () => {
  it('renders children when not demo and can mutate', () => {
    useDemoStateMock.mockReturnValue({ isDemo: false, loading: false });
    useCanMutateMock.mockReturnValue(true);

    renderAtRestricted();

    expect(screen.getByText('Restricted content')).toBeInTheDocument();
  });

  it('renders nothing while loading', () => {
    useDemoStateMock.mockReturnValue({ isDemo: false, loading: true });
    useCanMutateMock.mockReturnValue(true);

    const { container } = renderAtRestricted();

    expect(container).toBeEmptyDOMElement();
  });

  it('redirects to / when demo', () => {
    useDemoStateMock.mockReturnValue({ isDemo: true, loading: false });
    useCanMutateMock.mockReturnValue(true);

    renderAtRestricted();

    expect(screen.getByText('Home page')).toBeInTheDocument();
    expect(screen.queryByText('Restricted content')).not.toBeInTheDocument();
  });

  it('redirects to / when canMutate is false', () => {
    useDemoStateMock.mockReturnValue({ isDemo: false, loading: false });
    useCanMutateMock.mockReturnValue(false);

    renderAtRestricted();

    expect(screen.getByText('Home page')).toBeInTheDocument();
    expect(screen.queryByText('Restricted content')).not.toBeInTheDocument();
  });
});
