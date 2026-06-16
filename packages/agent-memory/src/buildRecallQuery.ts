import { escapeTag } from '@betterdb/valkey-search-kit';
import type { MemoryScope } from './types';

export const SCORE_FIELD = '__score';
export const VECTOR_FIELD = 'vector';

export function buildScopeFilter(scope: MemoryScope, tags: string[]): string {
  const clauses: string[] = [];
  if (scope.threadId !== undefined) {
    clauses.push(`@threadId:{${escapeTag(scope.threadId)}}`);
  }
  if (scope.agentId !== undefined) {
    clauses.push(`@agentId:{${escapeTag(scope.agentId)}}`);
  }
  if (scope.namespace !== undefined) {
    clauses.push(`@namespace:{${escapeTag(scope.namespace)}}`);
  }
  for (const tag of tags) {
    clauses.push(`@tags:{${escapeTag(tag)}}`);
  }
  if (clauses.length === 0) {
    return '*';
  }
  return `(${clauses.join(' ')})`;
}

export function buildRecallQuery(k: number, scope: MemoryScope, tags: string[]): string {
  return `${buildScopeFilter(scope, tags)}=>[KNN ${k} @${VECTOR_FIELD} $vec AS ${SCORE_FIELD}]`;
}
