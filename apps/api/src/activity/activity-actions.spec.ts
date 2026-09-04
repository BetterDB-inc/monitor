import { actionFor, targetFor } from './activity-actions';

describe('actionFor', () => {
  it('maps known routes to short names', () => {
    expect(actionFor('POST', '/connections')).toBe('connection.create');
    expect(actionFor('DELETE', '/connections/:id')).toBe('connection.delete');
    expect(actionFor('POST', '/bulk-delete/execute')).toBe('bulk_delete.run');
    expect(actionFor('POST', '/workspace/invite')).toBe('member.invite');
    expect(actionFor('PATCH', '/workspace/members/:userId/role')).toBe('member.role');
  });

  it('strips the api prefix and upper-cases the method', () => {
    expect(actionFor('post', '/api/connections')).toBe('connection.create');
  });

  it('keeps unmapped routes as METHOD pattern', () => {
    expect(actionFor('POST', '/api/connections/test')).toBe('POST /connections/test');
  });
});

describe('targetFor', () => {
  it('reads created ids from the response body', () => {
    expect(targetFor('connection.create', {}, {}, { id: 'c1' })).toEqual({
      type: 'connection',
      id: 'c1',
    });
    expect(targetFor('bulk_delete.run', {}, {}, { jobId: 'j1', status: 'queued' })).toEqual({
      type: 'bulk_delete',
      id: 'j1',
    });
    expect(targetFor('member.invite', {}, {}, { id: 'i1', email: 'x@y' })).toEqual({
      type: 'invitation',
      id: 'i1',
    });
  });

  it('reads ids from route params', () => {
    expect(targetFor('connection.delete', { id: 'c1' }, {}, undefined)).toEqual({
      type: 'connection',
      id: 'c1',
    });
    expect(targetFor('member.remove', { userId: 'u2' }, {}, undefined)).toEqual({
      type: 'member',
      id: 'u2',
    });
    expect(targetFor('invitation.revoke', { id: 'i1' }, {}, undefined)).toEqual({
      type: 'invitation',
      id: 'i1',
    });
  });

  it('reads the new owner from the request body', () => {
    expect(targetFor('ownership.transfer', {}, { userId: 'u3' }, undefined)).toEqual({
      type: 'member',
      id: 'u3',
    });
  });

  it('returns null when nothing identifies a target', () => {
    expect(targetFor('connection.create', {}, {}, undefined)).toBeNull();
    expect(targetFor('POST /connections/test', {}, {}, { ok: true })).toBeNull();
  });
});
