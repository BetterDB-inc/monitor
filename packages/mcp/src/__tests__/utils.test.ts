import { describe, it, expect } from 'vitest';
import {
  isJsonResponse,
  isLicenseError,
  licenseErrorResult,
  resolveInstanceId,
  buildQuery,
  formatProposalText,
  getArgValue,
  parseErrorResponse,
} from '../utils.js';

// --- isJsonResponse ---

describe('isJsonResponse', () => {
  const makeRes = (ct: string) => ({
    headers: { get: (key: string) => (key === 'content-type' ? ct : null) },
  });

  it('returns true for application/json', () => {
    expect(isJsonResponse(makeRes('application/json'))).toBe(true);
  });

  it('returns true for application/json; charset=utf-8', () => {
    expect(isJsonResponse(makeRes('application/json; charset=utf-8'))).toBe(true);
  });

  it('returns false for text/html', () => {
    expect(isJsonResponse(makeRes('text/html'))).toBe(false);
  });

  it('returns false when content-type is missing', () => {
    expect(isJsonResponse(makeRes(''))).toBe(false);
  });
});

// --- isLicenseError ---

describe('isLicenseError', () => {
  it('returns true for a license error payload', () => {
    expect(
      isLicenseError({
        __licenseError: true,
        requiredTier: 'Pro',
        currentTier: 'community',
        upgradeUrl: 'https://betterdb.com/pricing',
      }),
    ).toBe(true);
  });

  it('returns false for a normal object', () => {
    expect(isLicenseError({ data: 'ok' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isLicenseError(null)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isLicenseError('error')).toBe(false);
  });

  it('returns false when __licenseError is false', () => {
    expect(isLicenseError({ __licenseError: false })).toBe(false);
  });
});

// --- licenseErrorResult ---

describe('licenseErrorResult', () => {
  it('formats the message with all fields', () => {
    const msg = licenseErrorResult({
      requiredTier: 'Pro or Enterprise',
      currentTier: 'community',
      upgradeUrl: 'https://betterdb.com/pricing',
    });
    expect(msg).toBe(
      'This feature requires a Pro or Enterprise license (current tier: community). Upgrade at https://betterdb.com/pricing',
    );
  });
});

// --- resolveInstanceId ---

describe('resolveInstanceId', () => {
  it('returns the override id when provided', () => {
    expect(resolveInstanceId('active-1', 'override-2')).toBe('override-2');
  });

  it('falls back to activeInstanceId when no override', () => {
    expect(resolveInstanceId('active-1')).toBe('active-1');
  });

  it('throws when both activeInstanceId and override are absent', () => {
    expect(() => resolveInstanceId(null)).toThrow(
      'No instance selected. Call list_instances then select_instance first.',
    );
  });

  it('throws for an id with invalid characters', () => {
    expect(() => resolveInstanceId(null, 'bad id!')).toThrow('Invalid instance ID: bad id!');
  });

  it('throws a clear error when override is an empty string', () => {
    expect(() => resolveInstanceId('active-1', '')).toThrow(
      'Instance ID override must not be an empty string.',
    );
  });

  it('accepts alphanumeric, hyphens, and underscores', () => {
    expect(resolveInstanceId(null, 'inst_abc-123')).toBe('inst_abc-123');
  });
});

// --- buildQuery ---

describe('buildQuery', () => {
  it('returns empty string when all params are undefined', () => {
    expect(buildQuery({ a: undefined, b: undefined })).toBe('');
  });

  it('returns empty string for an empty object', () => {
    expect(buildQuery({})).toBe('');
  });

  it('builds a single-param query string', () => {
    expect(buildQuery({ limit: 25 })).toBe('?limit=25');
  });

  it('builds a multi-param query string', () => {
    const qs = buildQuery({ startTime: 1000, endTime: 2000 });
    expect(qs).toBe('?startTime=1000&endTime=2000');
  });

  it('omits undefined values', () => {
    expect(buildQuery({ limit: 10, command: undefined })).toBe('?limit=10');
  });

  it('percent-encodes spaces in values', () => {
    expect(buildQuery({ q: 'a b' })).toBe('?q=a%20b');
  });

  it('does not encode unreserved characters like dots', () => {
    expect(buildQuery({ command: 'FT.SEARCH' })).toBe('?command=FT.SEARCH');
  });

  it('percent-encodes special characters in keys', () => {
    expect(buildQuery({ 'has space': 'val' })).toBe('?has%20space=val');
  });
});

// --- formatProposalText ---

describe('formatProposalText', () => {
  const BASE = {
    proposal_id: 'prop-abc',
    status: 'pending',
    expires_at: new Date('2025-01-01T00:00:00.000Z').getTime(),
    warnings: [],
  };

  it('formats a proposal without warnings', () => {
    const result = formatProposalText(BASE);
    expect(result.content[0].text).toContain('Proposal created: prop-abc');
    expect(result.content[0].text).toContain('Status: pending');
    expect(result.content[0].text).toContain('Expires at: 2025-01-01T00:00:00.000Z');
    expect(result.content[0].text).not.toContain('Warnings:');
  });

  it('includes warnings when present', () => {
    const result = formatProposalText({ ...BASE, warnings: ['ttl too low', 'key missing'] });
    expect(result.content[0].text).toContain('Warnings: ttl too low; key missing');
  });

  it('does not set isError', () => {
    expect(formatProposalText(BASE).isError).toBeUndefined();
  });
});

// --- getArgValue ---

describe('getArgValue', () => {
  it('returns the value following a flag', () => {
    expect(getArgValue(['--port', '4000'], '--port', '3001')).toBe('4000');
  });

  it('returns the fallback when the flag is absent', () => {
    expect(getArgValue(['--storage', 'sqlite'], '--port', '3001')).toBe('3001');
  });

  it('returns the fallback when the flag is the last arg (no value)', () => {
    expect(getArgValue(['--port'], '--port', '3001')).toBe('3001');
  });

  it('returns the fallback when the next token starts with --', () => {
    expect(getArgValue(['--port', '--persist'], '--port', '3001')).toBe('3001');
  });
});

// --- parseErrorResponse ---

describe('parseErrorResponse', () => {
  it('extracts error field from JSON', () => {
    expect(parseErrorResponse(JSON.stringify({ error: 'not found' }), 404)).toBe('not found');
  });

  it('extracts message field from JSON when error is absent', () => {
    expect(parseErrorResponse(JSON.stringify({ message: 'forbidden' }), 403)).toBe('forbidden');
  });

  it('returns raw text when not JSON', () => {
    expect(parseErrorResponse('Bad gateway', 502)).toBe('Bad gateway');
  });

  it('returns the status fallback when body is empty', () => {
    expect(parseErrorResponse('', 500)).toBe('Request failed with status 500');
  });
});
