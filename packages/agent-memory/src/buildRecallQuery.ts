import { escapeTag } from '@betterdb/valkey-search-kit';
import type { MemoryScope } from './types';

export const SCORE_FIELD = '__score';
export const VECTOR_FIELD = 'vector';

function scopeClauses(scope: MemoryScope, tags: string[]): string[] {
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
  return clauses;
}

function joinClauses(clauses: string[]): string {
  if (clauses.length === 0) {
    return '*';
  }
  return `(${clauses.join(' ')})`;
}

export function buildScopeFilter(scope: MemoryScope, tags: string[]): string {
  return joinClauses(scopeClauses(scope, tags));
}

export interface ConsolidateFilterOptions {
  maxCreatedAt?: number;
  maxImportance?: number;
  excludeSource?: string;
}

export function buildConsolidateFilter(
  scope: MemoryScope,
  tags: string[],
  options: ConsolidateFilterOptions,
): string {
  const clauses = scopeClauses(scope, tags);
  if (options.maxCreatedAt !== undefined) {
    clauses.push(`@created_at:[-inf ${options.maxCreatedAt}]`);
  }
  if (options.maxImportance !== undefined) {
    clauses.push(`@importance:[-inf ${options.maxImportance}]`);
  }
  if (options.excludeSource !== undefined) {
    clauses.push(`-@source:{${escapeTag(options.excludeSource)}}`);
  }
  return joinClauses(clauses);
}

export function buildRecallQuery(k: number, scope: MemoryScope, tags: string[]): string {
  return `${buildScopeFilter(scope, tags)}=>[KNN ${k} @${VECTOR_FIELD} $vec AS ${SCORE_FIELD}]`;
}
