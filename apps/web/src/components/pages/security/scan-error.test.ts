import { describe, expect, it } from 'vitest';
import { MISSING_CONNECTION_MESSAGE, parseScanFailure, scanErrorMessage } from './scan-error';

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

describe('parseScanFailure', () => {
  it('splits the per-node reasons out of an unreachable-connection error', () => {
    const error = new Error(
      'No node in this connection could be scanned: 127.0.0.1:7401: Connection refused; 127.0.0.1:7402: NOAUTH Authentication required',
    );
    const failure = parseScanFailure(error, FALLBACK);

    expect(failure.summary).toBe('No node in this connection could be scanned.');
    expect(failure.nodes).toEqual([
      { address: '127.0.0.1:7401', reason: 'Connection refused' },
      { address: '127.0.0.1:7402', reason: 'NOAUTH Authentication required' },
    ]);
  });

  it('keeps a single unreachable node as one row', () => {
    const error = new Error(
      "No node in this connection could be scanned: localhost:6395: Stream isn't writeable",
    );

    expect(parseScanFailure(error, FALLBACK).nodes).toEqual([
      { address: 'localhost:6395', reason: "Stream isn't writeable" },
    ]);
  });

  it('leaves an unrelated error as a plain summary with no rows', () => {
    const failure = parseScanFailure(new Error('CVE dataset is still being built'), FALLBACK);

    expect(failure.summary).toBe('CVE dataset is still being built');
    expect(failure.nodes).toEqual([]);
  });

  it('does not invent rows when the detail is not address-and-reason pairs', () => {
    const error = new Error('No node in this connection could be scanned: nothing was discovered');
    const failure = parseScanFailure(error, FALLBACK);

    expect(failure.nodes).toEqual([]);
    expect(failure.summary).toContain('nothing was discovered');
  });
});
