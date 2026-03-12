import type {
  VectorIndexInfo,
  VectorIndexField,
  VectorIndexGcStats,
  VectorIndexDefinition,
  VectorSearchResult,
} from '../../common/types/metrics.types';

export const FIELD_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
export const INDEX_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_.\-]*$/;

/** Sanitize and validate a vector search filter string. Returns the trimmed filter or undefined. */
export function sanitizeFilter(filter?: string): string | undefined {
  const trimmed = filter?.trim();
  if (trimmed && (trimmed.length > 1024 || /[\x00-\x1f]/.test(trimmed) || trimmed.includes('=>'))) {
    throw new Error('Invalid filter: too long, contains control characters, or contains forbidden operator');
  }
  return trimmed || undefined;
}

/** Parse a flat key-value array into a Map */
export function toMap(arr: unknown[]): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (let i = 0; i < arr.length; i += 2) {
    m.set(String(arr[i]), arr[i + 1]);
  }
  return m;
}

export function parseVectorIndexInfo(indexName: string, raw: unknown[]): VectorIndexInfo {
  const map = toMap(raw);

  const numDocs = Number(map.get('num_docs') ?? 0);
  const numRecords = Number(map.get('num_records') ?? 0);
  const indexingFailures = Number(map.get('hash_indexing_failures') ?? 0);

  // Valkey Search: "backfill_complete_percent" (float 0-1), RediSearch: "percent_indexed" (float 0-1)
  const backfillPercent = map.get('backfill_complete_percent');
  const percentRaw = backfillPercent ?? map.get('percent_indexed') ?? 0;
  const num = Number(percentRaw);
  // Values > 1 are already in 0-100 range (some Valkey Search versions); values <= 1 are 0-1 floats
  const percentIndexed = num > 1 ? Math.min(num, 100) : Math.min(num * 100, 100);

  // Valkey Search: "state" ("ready"|"backfilling"|...), RediSearch: "indexing" (0|1)
  const stateRaw = map.get('state');
  const indexingRaw = map.get('indexing');
  let indexingState: string;
  if (stateRaw !== undefined) {
    indexingState = stateRaw === 'ready' ? 'indexed' : 'indexing';
  } else {
    indexingState = (indexingRaw === '1' || indexingRaw === 1) ? 'indexing' : 'indexed';
  }

  let memorySizeMb = Number(map.get('vector_index_sz_mb') ?? 0);
  if (memorySizeMb === 0) {
    const inverted = Number(map.get('inverted_sz_mb') ?? 0);
    const offsetVectors = Number(map.get('offset_vectors_sz_mb') ?? 0);
    const docTable = Number(map.get('doc_table_size_mb') ?? 0);
    const keyTable = Number(map.get('key_table_size_mb') ?? 0);
    memorySizeMb = inverted + offsetVectors + docTable + keyTable;
  }

  // Parse all attributes into fields
  const fields: VectorIndexField[] = [];
  let numVectorFields = 0;
  const attributes = map.get('attributes');
  if (Array.isArray(attributes)) {
    for (const attr of attributes) {
      if (!Array.isArray(attr)) continue;
      const field = parseAttributeField(attr);
      fields.push(field);
      if (field.type === 'VECTOR') numVectorFields++;
    }
  }

  // Parse gc_stats (RediSearch only, absent in Valkey Search)
  const gcStats = parseGcStats(map.get('gc_stats'));

  // Parse index_definition
  const indexDefinition = parseIndexDefinition(map.get('index_definition'));

  return {
    name: indexName,
    numDocs,
    numRecords,
    numVectorFields,
    indexingState,
    percentIndexed,
    memorySizeMb,
    indexingFailures,
    fields,
    gcStats,
    indexDefinition,
  };
}

export function parseAttributeField(attr: unknown[]): VectorIndexField {
  const attrMap = toMap(attr);
  const name = String(attrMap.get('identifier') ?? attrMap.get('attribute') ?? '');
  const type = String(attrMap.get('type') ?? '').toUpperCase();

  let algorithm: string | null = null;
  let dimension: number | null = null;
  let distanceMetric: string | null = null;
  let hnswM: number | null = null;
  let hnswEfConstruction: number | null = null;
  let hnswEfRuntime: number | null = null;

  if (type === 'VECTOR') {
    // Valkey Search: vector params nested under "index" key
    const indexData = attrMap.get('index');
    if (Array.isArray(indexData)) {
      const idxMap = toMap(indexData);
      dimension = Number(idxMap.get('dimensions') ?? idxMap.get('DIM') ?? null);
      if (isNaN(dimension as number)) dimension = null;
      const dm = idxMap.get('distance_metric') ?? idxMap.get('DISTANCE_METRIC');
      distanceMetric = dm != null ? String(dm) : null;
      const algoData = idxMap.get('algorithm');
      if (Array.isArray(algoData)) {
        const algoMap = toMap(algoData);
        algorithm = algoMap.has('name') ? String(algoMap.get('name')) : null;
        // HNSW params from algorithm sub-array
        const m = algoMap.get('m') ?? algoMap.get('M');
        if (m != null) hnswM = Number(m);
        const efC = algoMap.get('ef_construction') ?? algoMap.get('EF_CONSTRUCTION');
        if (efC != null) hnswEfConstruction = Number(efC);
        const efR = algoMap.get('ef_runtime') ?? algoMap.get('EF_RUNTIME');
        if (efR != null) hnswEfRuntime = Number(efR);
      } else if (typeof algoData === 'string') {
        algorithm = algoData;
      }
    }

    // RediSearch: DIM/DISTANCE_METRIC/algorithm may be flat in the attribute array
    if (dimension === null && attrMap.has('DIM')) {
      dimension = Number(attrMap.get('DIM'));
    }
    if (distanceMetric === null && attrMap.has('DISTANCE_METRIC')) {
      distanceMetric = String(attrMap.get('DISTANCE_METRIC'));
    }
    if (algorithm === null && attrMap.has('algorithm') && typeof attrMap.get('algorithm') === 'string') {
      algorithm = String(attrMap.get('algorithm'));
    }
    // RediSearch: HNSW params flat in attribute array
    if (hnswM === null && (attrMap.has('M') || attrMap.has('m'))) {
      hnswM = Number(attrMap.get('M') ?? attrMap.get('m'));
    }
    if (hnswEfConstruction === null && (attrMap.has('EF_CONSTRUCTION') || attrMap.has('ef_construction'))) {
      hnswEfConstruction = Number(attrMap.get('EF_CONSTRUCTION') ?? attrMap.get('ef_construction'));
    }
    if (hnswEfRuntime === null && (attrMap.has('EF_RUNTIME') || attrMap.has('ef_runtime'))) {
      hnswEfRuntime = Number(attrMap.get('EF_RUNTIME') ?? attrMap.get('ef_runtime'));
    }
  }

  // Non-vector field attributes
  const sepRaw = attrMap.get('SEPARATOR') ?? attrMap.get('separator');
  const separator = sepRaw != null ? String(sepRaw) : null;
  const caseSensitive = attrMap.has('CASESENSITIVE') || attrMap.has('case_sensitive');
  const sortable = attrMap.has('SORTABLE') || attrMap.has('sortable');
  const noStem = attrMap.has('NOSTEM') || attrMap.has('nostem');
  const weightRaw = attrMap.get('WEIGHT') ?? attrMap.get('weight');
  const weight = weightRaw != null ? Number(weightRaw) : null;

  return {
    name, type, algorithm, dimension, distanceMetric,
    hnswM, hnswEfConstruction, hnswEfRuntime,
    separator, caseSensitive, sortable, noStem, weight,
  };
}

export function parseGcStats(raw: unknown): VectorIndexGcStats | null {
  if (!Array.isArray(raw)) return null;
  try {
    const m = toMap(raw);
    return {
      gcCycles: Number(m.get('gc_stats_cycles') ?? m.get('gc_numeric_trees_missed') ?? 0),
      bytesCollected: Number(m.get('bytes_collected') ?? 0),
      totalMsRun: Number(m.get('total_ms_run') ?? 0),
    };
  } catch {
    return null;
  }
}

export function parseIndexDefinition(raw: unknown): VectorIndexDefinition | null {
  if (!Array.isArray(raw)) return null;
  try {
    const m = toMap(raw);
    const prefixesRaw = m.get('prefixes');
    const prefixes = Array.isArray(prefixesRaw) ? prefixesRaw.map(String) : [];
    const lang = m.get('default_language');
    const score = m.get('default_score');
    return {
      prefixes,
      defaultLanguage: lang != null ? String(lang) : null,
      defaultScore: score != null ? Number(score) : null,
    };
  } catch {
    return null;
  }
}

export function parseVectorSearchResponse(raw: unknown[], vectorFieldName: string): VectorSearchResult[] {
  const results: VectorSearchResult[] = [];
  const scoreKey = `__${vectorFieldName}_score`;

  for (let i = 1; i < raw.length; i += 2) {
    const key = String(raw[i]);
    const fieldsArr = raw[i + 1] as unknown[];
    if (!Array.isArray(fieldsArr)) continue;

    const fields: Record<string, string> = {};
    let score = 0;

    for (let j = 0; j < fieldsArr.length; j += 2) {
      const fieldName = String(fieldsArr[j]);
      const fieldValue = fieldsArr[j + 1];
      if (fieldName === scoreKey) {
        score = Number(fieldValue);
      } else if (fieldName !== vectorFieldName) {
        fields[fieldName] = String(fieldValue);
      }
    }

    results.push({ key, score, fields });
  }

  return results;
}
