import { escapeTag } from '@betterdb/valkey-search-kit';
import type { MemoryScope } from './types';

export const SCORE_FIELD = '__score';
export const VECTOR_FIELD = 'vector';

export function buildRecallQuery(k: number, scope: MemoryScope, tags: string[]): string {
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
  const filterExpr = clauses.length > 0 ? `(${clauses.join(' ')})` : '*';
  return `${filterExpr}=>[KNN ${k} @${VECTOR_FIELD} $vec AS ${SCORE_FIELD}]`;
}
