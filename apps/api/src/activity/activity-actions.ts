import { stripApiPrefix } from '../auth/guards/public-paths';

export interface ActivityTarget {
  type: string;
  id: string;
}

export const ACTION_MAP: Readonly<Record<string, string>> = {
  'POST /connections': 'connection.create',
  'DELETE /connections/:id': 'connection.delete',
  'POST /connections/:id/default': 'connection.set_default',
  'POST /connections/:id/reconnect': 'connection.reconnect',
  'POST /bulk-delete/execute': 'bulk_delete.run',
  'POST /workspace/invite': 'member.invite',
  'DELETE /workspace/invitations/:id': 'invitation.revoke',
  'DELETE /workspace/members/:userId': 'member.remove',
  'PATCH /workspace/members/:userId/role': 'member.role',
  'POST /workspace/ownership/transfer': 'ownership.transfer',
};

type TargetSource = 'response' | 'param' | 'body';

interface TargetRule {
  type: string;
  source: TargetSource;
  key: string;
}

const TARGET_RULES: Readonly<Record<string, TargetRule>> = {
  'connection.create': { type: 'connection', source: 'response', key: 'id' },
  'connection.delete': { type: 'connection', source: 'param', key: 'id' },
  'connection.set_default': { type: 'connection', source: 'param', key: 'id' },
  'connection.reconnect': { type: 'connection', source: 'param', key: 'id' },
  'bulk_delete.run': { type: 'bulk_delete', source: 'response', key: 'jobId' },
  'member.invite': { type: 'invitation', source: 'response', key: 'id' },
  'invitation.revoke': { type: 'invitation', source: 'param', key: 'id' },
  'member.remove': { type: 'member', source: 'param', key: 'userId' },
  'member.role': { type: 'member', source: 'param', key: 'userId' },
  'ownership.transfer': { type: 'member', source: 'body', key: 'userId' },
};

export function actionFor(method: string, pattern: string): string {
  const key = `${method.toUpperCase()} ${stripApiPrefix(pattern)}`;
  const mapped = ACTION_MAP[key];
  if (mapped !== undefined) {
    return mapped;
  }
  return key;
}

function readString(source: unknown, key: string): string | null {
  if (typeof source !== 'object' || source === null) {
    return null;
  }
  const value = (source as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return value;
}

export function targetFor(
  action: string,
  params: Record<string, string>,
  body: unknown,
  response: unknown,
): ActivityTarget | null {
  const rule = TARGET_RULES[action];
  if (rule === undefined) {
    return null;
  }
  let id: string | null = null;
  if (rule.source === 'response') {
    id = readString(response, rule.key);
  }
  if (rule.source === 'param') {
    id = readString(params, rule.key);
  }
  if (rule.source === 'body') {
    id = readString(body, rule.key);
  }
  if (id === null) {
    return null;
  }
  return { type: rule.type, id };
}
