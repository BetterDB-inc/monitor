import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { KeyPanel } from '../KeyPanel';
import { failedKey, parsedKey } from './fixtures';

const panel = (key: string) => screen.getByRole('region', { name: key });

describe('KeyPanel', () => {
  it('starts collapsed so the value is not rendered until asked for', () => {
    render(<KeyPanel view={parsedKey()} />);
    expect(screen.queryByText('Where should I stay?')).not.toBeInTheDocument();
    expect(screen.queryByTestId('raw-value')).not.toBeInTheDocument();
  });

  it('shows the timeline in structured view on request', () => {
    render(<KeyPanel view={parsedKey()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Structured' }));
    expect(screen.getByText('Where should I stay?')).toBeInTheDocument();
    expect(screen.getByText('Alfama for atmosphere.')).toBeInTheDocument();
  });

  it('collapses the value again', () => {
    render(<KeyPanel view={parsedKey()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByTestId('raw-value')).not.toBeInTheDocument();
  });

  it('pretty-prints a JSON string in raw view', () => {
    const raw = '{"type":"human","data":{"content":"hi"}}';
    render(<KeyPanel view={parsedKey({ raw })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByTestId('raw-value').textContent).toBe(
      JSON.stringify(JSON.parse(raw), null, 2),
    );
  });

  it('shows a plain string as is in raw view', () => {
    render(<KeyPanel view={parsedKey({ raw: 'just text' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByTestId('raw-value').textContent).toBe('just text');
  });

  it('shows the base64 notice for a binary value', () => {
    render(<KeyPanel view={failedKey({ raw: 'AAEC', binary: true })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByText(/not valid UTF-8, shown as base64/)).toBeInTheDocument();
    expect(screen.getByTestId('raw-value').textContent).toBe('AAEC');
  });

  it('treats a JSON value with a base64 property as text', () => {
    render(<KeyPanel view={failedKey({ type: 'json', raw: { base64: 'aGk=' } })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.queryByText(/not valid UTF-8/)).not.toBeInTheDocument();
    expect(screen.getByTestId('raw-value').textContent).toContain('"base64": "aGk="');
  });

  it('shows a whole hash that has a field named base64', () => {
    render(
      <KeyPanel view={failedKey({ type: 'hash', raw: { base64: 'aGk=', role: 'user' } })} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.queryByText(/not valid UTF-8/)).not.toBeInTheDocument();
    expect(screen.getByTestId('raw-value').textContent).toContain('"role": "user"');
  });

  it('shows the reason and offers only raw for an unparsed key', () => {
    render(<KeyPanel view={failedKey()} />);
    expect(screen.getByText(/Element is not a \{type, data\} message envelope/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByTestId('raw-value').textContent).toBe('not a message');
    expect(screen.getByRole('button', { name: 'Structured' })).toBeDisabled();
  });

  it('toggles one key without changing another', () => {
    render(
      <>
        <KeyPanel view={parsedKey({ key: 'a' })} />
        <KeyPanel view={parsedKey({ key: 'b' })} />
      </>,
    );
    fireEvent.click(within(panel('a')).getByRole('button', { name: 'Raw' }));
    fireEvent.click(within(panel('b')).getByRole('button', { name: 'Structured' }));
    fireEvent.click(within(panel('a')).getByRole('button', { name: 'Raw' }));
    expect(within(panel('a')).getByTestId('raw-value')).toBeInTheDocument();
    expect(within(panel('b')).queryByTestId('raw-value')).not.toBeInTheDocument();
    expect(within(panel('b')).getByText('Where should I stay?')).toBeInTheDocument();
  });

  it('flags a truncated value', () => {
    render(<KeyPanel view={parsedKey({ truncated: true })} />);
    expect(screen.getByText('Truncated')).toBeInTheDocument();
  });
});
