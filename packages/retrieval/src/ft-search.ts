import { escapeTag } from '@betterdb/valkey-search-kit';
import type { RetrievalSchema } from './schema';
import { resolveVectorFieldName } from './ft-create';
import { SCORE_FIELD } from './fields';

export type QueryFilter = Record<string, string | number>;

function buildFilterClause(field: string, value: string | number, schema: RetrievalSchema): string {
  const spec = schema.fields[field];
  if (spec === undefined) {
    throw new Error(`Cannot filter on unknown field '${field}'`);
  }
  if (spec.type === 'tag') {
    return `@${field}:{${escapeTag(String(value))}}`;
  }
  if (spec.type === 'numeric') {
    if (typeof value !== 'number') {
      throw new Error(`Numeric filter on field '${field}' requires a number, got: ${typeof value}`);
    }
    return `@${field}:[${value} ${value}]`;
  }
  throw new Error(
    `Cannot filter on TEXT field '${field}'; only tag and numeric fields are filterable`,
  );
}

export function buildFtSearchQuery(
  schema: RetrievalSchema,
  k: number,
  filter?: QueryFilter,
): string {
  const vectorField = resolveVectorFieldName(schema.vector);
  const clauses: string[] = [];
  if (filter !== undefined) {
    for (const [field, value] of Object.entries(filter)) {
      clauses.push(buildFilterClause(field, value, schema));
    }
  }
  const filterExpr = clauses.length > 0 ? `(${clauses.join(' ')})` : '*';
  return `${filterExpr}=>[KNN ${k} @${vectorField} $vec AS ${SCORE_FIELD}]`;
}
