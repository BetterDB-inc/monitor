import type { RetrievalSchema, FtCapabilities, FieldSpec, VectorSpec } from './schema';

const HNSW_DEFAULTS = {
  m: 16,
  efConstruction: 200,
  efRuntime: 10,
};

const METRIC_MAP: Record<import('./schema').VectorMetric, string> = {
  cosine: 'COSINE',
  l2: 'L2',
  ip: 'IP',
};

function requireDims(dims: number | undefined): number {
  if (dims === undefined || !Number.isInteger(dims) || dims <= 0) {
    throw new Error(`dims must be a positive integer to build FT.CREATE args, got: ${dims}`);
  }
  return dims;
}

function validateFieldNames(fields: Record<string, FieldSpec>, vectorFieldName: string): void {
  for (const name of Object.keys(fields)) {
    if (name.length === 0) {
      throw new Error('Invalid field name: empty field name is not allowed');
    }
    if (name === vectorFieldName) {
      throw new Error(
        `Field name '${name}' collides with the vector field name '${vectorFieldName}'`,
      );
    }
  }
}

function validateTextFieldCapabilities(
  fields: Record<string, FieldSpec>,
  capabilities: FtCapabilities | undefined,
): void {
  if (capabilities?.textFields !== false) {
    return;
  }
  const textFieldNames = Object.entries(fields)
    .filter(([, spec]) => spec.type === 'text')
    .map(([name]) => name);
  if (textFieldNames.length > 0) {
    throw new Error(`Text fields require valkey-search >= 1.2: ${textFieldNames.join(', ')}`);
  }
}

function validateFlatHnswParams(vector: VectorSpec): void {
  if (vector.algorithm !== 'flat') {
    return;
  }
  if ('m' in vector && vector.m !== undefined) {
    throw new Error(`FLAT algorithm does not support 'm' parameter`);
  }
  if ('efConstruction' in vector && vector.efConstruction !== undefined) {
    throw new Error(`FLAT algorithm does not support 'efConstruction' parameter`);
  }
  if ('efRuntime' in vector && vector.efRuntime !== undefined) {
    throw new Error(`FLAT algorithm does not support 'efRuntime' parameter`);
  }
}

function buildFieldArgs(name: string, spec: FieldSpec): string[] {
  if (spec.type === 'text') {
    return [name, 'TEXT'];
  }
  if (spec.type === 'tag') {
    const args = [name, 'TAG'];
    if (spec.separator !== undefined) {
      args.push('SEPARATOR', spec.separator);
    }
    return args;
  }
  const args = [name, 'NUMERIC'];
  if (spec.sortable === true) {
    args.push('SORTABLE');
  }
  return args;
}

export function resolveVectorFieldName(vector: VectorSpec): string {
  if (vector.fieldName === undefined) {
    return 'embedding';
  }
  if (vector.fieldName.trim().length === 0) {
    throw new Error(
      `Vector field name must not be empty or whitespace-only, got: '${vector.fieldName}'`,
    );
  }
  return vector.fieldName;
}

function buildVectorArgs(vector: VectorSpec, dims: number): string[] {
  const fieldName = resolveVectorFieldName(vector);
  const algo = vector.algorithm.toUpperCase();
  const metric = METRIC_MAP[vector.metric];

  if (vector.algorithm === 'flat') {
    return [
      fieldName,
      'VECTOR',
      algo,
      '6',
      'TYPE',
      'FLOAT32',
      'DIM',
      String(dims),
      'DISTANCE_METRIC',
      metric,
    ];
  }

  const m = vector.m ?? HNSW_DEFAULTS.m;
  const efConstruction = vector.efConstruction ?? HNSW_DEFAULTS.efConstruction;
  const efRuntime = vector.efRuntime ?? HNSW_DEFAULTS.efRuntime;

  return [
    fieldName,
    'VECTOR',
    algo,
    '12',
    'TYPE',
    'FLOAT32',
    'DIM',
    String(dims),
    'DISTANCE_METRIC',
    metric,
    'M',
    String(m),
    'EF_CONSTRUCTION',
    String(efConstruction),
    'EF_RUNTIME',
    String(efRuntime),
  ];
}

export function indexName(name: string): string {
  if (name.trim().length === 0) {
    throw new Error(`Index name must not be empty or whitespace-only, got: '${name}'`);
  }
  return `${name}:idx`;
}

export function keyPrefix(name: string): string {
  if (name.trim().length === 0) {
    throw new Error(`Index name must not be empty or whitespace-only, got: '${name}'`);
  }
  return `${name}:`;
}

export function buildFtCreateArgs(
  name: string,
  schema: RetrievalSchema,
  capabilities?: FtCapabilities,
): string[] {
  if (name.trim().length === 0) {
    throw new Error(`Index name must not be empty or whitespace-only, got: '${name}'`);
  }

  const dims = requireDims(schema.vector.dims);
  const vectorFieldName = resolveVectorFieldName(schema.vector);

  validateFieldNames(schema.fields, vectorFieldName);
  validateTextFieldCapabilities(schema.fields, capabilities);
  validateFlatHnswParams(schema.vector);

  const fieldArgs: string[] = [];
  for (const [fieldName, spec] of Object.entries(schema.fields)) {
    for (const token of buildFieldArgs(fieldName, spec)) {
      fieldArgs.push(token);
    }
  }

  const vectorArgs = buildVectorArgs(schema.vector, dims);

  return [
    indexName(name),
    'ON',
    'HASH',
    'PREFIX',
    '1',
    keyPrefix(name),
    'SCHEMA',
    ...fieldArgs,
    ...vectorArgs,
  ];
}
