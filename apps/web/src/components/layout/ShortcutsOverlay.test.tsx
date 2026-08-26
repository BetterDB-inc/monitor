import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { ShortcutsOverlay } from './ShortcutsOverlay';

function Go({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(to)}>go</button>;
}

function renderOverlay(onClose: () => void) {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Go to="/slowlog" />
      <Routes>
        <Route path="*" element={<span>page</span>} />
      </Routes>
      <ShortcutsOverlay onClose={onClose} />
    </MemoryRouter>,
  );
}

describe('ShortcutsOverlay', () => {
  it('stays open on the route it was opened from', () => {
    const onClose = vi.fn();
    renderOverlay(onClose);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes once a navigation chord takes effect', () => {
    // It lists those chords, and they keep firing while it is open — so without
    // this it sits over the page the user just asked for.
    const onClose = vi.fn();
    renderOverlay(onClose);

    fireEvent.click(screen.getByText('go'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
