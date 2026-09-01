import { describe, expect, it } from 'vitest';
import { MISSING_CONNECTION_MESSAGE, scanErrorMessage } from './scan-error';

const FALLBACK = 'The server did not return a scan for this connection.';

describe('scanErrorMessage', () => {
  it('replaces a deleted connection with a message the reader can act on', () => {
    const error = new Error(
      "Connection 'conn-9' not found. Use GET /connections to list available connections.",
    );

    expect(scanErrorMessage(error, FALLBACK)).toBe(MISSING_CONNECTION_MESSAGE);
  });

  it('strips the API hint from an unrelated message rather than showing it to a user', () => {
    const error = new Error('Something broke. Use GET /connections to list available connections.');

    expect(scanErrorMessage(error, FALLBACK)).toBe('Something broke.');
  });

  it('keeps a message that carries real detail', () => {
    const error = new Error('CVE dataset is still being built');

    expect(scanErrorMessage(error, FALLBACK)).toBe('CVE dataset is still being built');
  });

  it('falls back when there is no error or the message is empty', () => {
    expect(scanErrorMessage(null, FALLBACK)).toBe(FALLBACK);
    expect(scanErrorMessage(new Error('   '), FALLBACK)).toBe(FALLBACK);
  });
});
