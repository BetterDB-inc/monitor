import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, 
      'CVE inspection is unavailable: this monitor build predates this tool — update the monitor to use it.',
    );
  });

  it('mentions Pro when the missing feature requires it', () => {
    const err = new ApiHttpError('x', 404, 'Cannot GET /api/mcp/instance/a/kv-cache/status');
    assert.ok(notFoundResult(err, 'KV cache monitoring').content[0].text.includes('requires BetterDB Pro'));
  });

  it('surfaces an unknown-instance 404 verbatim as an error', () => {
    const err = new ApiHttpError("Connection 'nope' not found", 404, "Connection 'nope' not found");
    assert.deepEqual(notFoundResult(err, 'CVE inspection', false), {
      content: [{ type: 'text', text: "Connection 'nope' not found" }],
      isError: true,
    });
  });

  it('falls back to the message when the body had no detail', () => {
    const err = new ApiHttpError('Request failed with status 404', 404);
    assert.deepEqual(notFoundResult(err, 'Fleet summary', false), {
      content: [{ type: 'text', text: 'Request failed with status 404' }],
      isError: true,
    });
  });
});

describe('apiErrorResult', () => {
  it('surfaces the server message from the response body', () => {
    const err = new ApiHttpError('Bad Request', 400, 'time range must not exceed 744 hours');
    assert.deepEqual(apiErrorResult(err), {
      content: [{ type: 'text', text: 'time range must not exceed 744 hours' }],
      isError: true,
    });
  });

  it('falls back to the generic message when the body was unparseable', () => {
    const err = new ApiHttpError('Request failed with status 502', 502);
    assert.deepEqual(apiErrorResult(err), {
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
    assert.equal(isLicenseError(payload), true);
    assert.equal(isLicenseError({ __licenseError: false }), false);
    assert.equal(isLicenseError(null), false);
    assert.equal(isLicenseError('Pro'), false);
    assert.equal(isLicenseError({}), false);
  });

  it('builds the upgrade message', () => {
    assert.equal(licenseErrorResult(payload), 
      'This feature requires a Pro license (current tier: community). Upgrade at https://betterdb.com/pricing',
    );
  });
});

describe('jsonResult', () => {
  it('emits compact JSON that round-trips', () => {
    const data = { sampling: { originalPoints: 8640, returnedPoints: 150 }, points: [{ t: 1, v: [1, 2] }], note: 'a\nb' };
    const result = jsonResult(data);
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.doesNotMatch(text, /\n|: |, {2}/);
    assert.deepEqual(JSON.parse(text), data);
  });
});
