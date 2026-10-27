import { describe, expect, it } from 'vitest';
import {
  ApiHttpError,
  apiErrorResult,
  isLicenseError,
  jsonResult,
  licenseErrorResult,
  notFoundResult,
} from './results.js';

describe('notFoundResult', () => {
  it('reports an old API when the route itself is missing', () => {
    const err = new ApiHttpError('Cannot GET /api/mcp/instance/a/cve', 404, 'Cannot GET /api/mcp/instance/a/cve');
    const result = notFoundResult(err, 'CVE inspection', false);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(
      'CVE inspection is unavailable: this monitor build predates this tool — update the monitor to use it.',
    );
  });

  it('mentions Pro when the missing feature requires it', () => {
    const err = new ApiHttpError('x', 404, 'Cannot GET /api/mcp/instance/a/kv-cache/status');
    expect(notFoundResult(err, 'KV cache monitoring').content[0].text).toContain('requires BetterDB Pro');
  });

  it('surfaces an unknown-instance 404 verbatim as an error', () => {
    const err = new ApiHttpError("Connection 'nope' not found", 404, "Connection 'nope' not found");
    expect(notFoundResult(err, 'CVE inspection', false)).toEqual({
      content: [{ type: 'text', text: "Connection 'nope' not found" }],
      isError: true,
    });
  });

  it('falls back to the message when the body had no detail', () => {
    const err = new ApiHttpError('Request failed with status 404', 404);
    expect(notFoundResult(err, 'Fleet summary', false)).toEqual({
      content: [{ type: 'text', text: 'Request failed with status 404' }],
      isError: true,
    });
  });
});

describe('apiErrorResult', () => {
  it('surfaces the server message from the response body', () => {
    const err = new ApiHttpError('Bad Request', 400, 'time range must not exceed 744 hours');
    expect(apiErrorResult(err)).toEqual({
      content: [{ type: 'text', text: 'time range must not exceed 744 hours' }],
      isError: true,
    });
  });

  it('falls back to the generic message when the body was unparseable', () => {
    const err = new ApiHttpError('Request failed with status 502', 502);
    expect(apiErrorResult(err)).toEqual({
      content: [{ type: 'text', text: 'Request failed with status 502' }],
      isError: true,
    });
  });
});

describe('license (402) handling', () => {
  const payload = {
    __licenseError: true as const,
    requiredTier: 'Pro',
    currentTier: 'community',
    upgradeUrl: 'https://betterdb.com/pricing',
  };

  it('recognises the license marker and nothing else', () => {
    expect(isLicenseError(payload)).toBe(true);
    expect(isLicenseError({ __licenseError: false })).toBe(false);
    expect(isLicenseError(null)).toBe(false);
    expect(isLicenseError('Pro')).toBe(false);
    expect(isLicenseError({})).toBe(false);
  });

  it('builds the upgrade message', () => {
    expect(licenseErrorResult(payload)).toBe(
      'This feature requires a Pro license (current tier: community). Upgrade at https://betterdb.com/pricing',
    );
  });
});

describe('jsonResult', () => {
  it('emits compact JSON that round-trips', () => {
    const data = { sampling: { originalPoints: 8640, returnedPoints: 150 }, points: [{ t: 1, v: [1, 2] }], note: 'a\nb' };
    const result = jsonResult(data);
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).not.toMatch(/\n|: |, {2}/);
    expect(JSON.parse(text)).toEqual(data);
  });
});
