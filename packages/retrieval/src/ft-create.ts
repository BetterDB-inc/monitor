import type { RetrievalSchema, FtCapabilities, FieldSpec } from './schema';

const HNSW_DEFAULTS = {
  m: 16,
  efConstruction: 200,
  efRuntime: 10,
};

const METRIC_MAP: Record<string, string> = {
  cosine: 'COSINE',
  l2: 'L2',
  ip: 'IP',
};

function validateDims(dims: number | undefined): void {
  if (dims === undefined || !Number.isInteger(dims) || dims <= 0) {
    throw new Error(
      'dims is required for FT.CREATE and must be a positive integer',
    );
  }
}

function validateFieldNames(
  fields: Record<string, FieldSpec>,
  vectorFieldName: string,
): void {
  for (const name of Object.keys(fields)) {
    if (name.length === 0) {
      throw new Error(`Invalid field name: empty field name is not allowed`);
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
    throw new Error(
      `Text fields require valkey-search >= 1.2: ${textFieldNames.join(', ')}`,
    );
  }
}

function validateFlatHnswParams(
  algorithm: string,
  m: number | undefined,
  efConstruction: number | undefined,
  efRuntime: number | undefined,
): void {
  if (algorithm !== 'flat') {
    return;
  }
  if (m !== undefined) {
    throw new Error(`FLAT algorithm does not support 'm' parameter`);
  }
  if (efConstruction !== undefined) {
    throw new Error(`FLAT algorithm does not support 'efConstruction' parameter`);
  }
  if (efRuntime !== undefined) {
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

function buildVectorArgs(schema: RetrievalSchema): string[] {
  const { vector } = schema;
  const fieldName = vector.fieldName ?? 'embedding';
  const algo = vector.algorithm.toUpperCase();
  const metric = METRIC_MAP[vector.metric];
  const dims = vector.dims as number;

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

export function buildFtCreateArgs(
  name: string,
  schema: RetrievalSchema,
  capabilities?: FtCapabilities,
): string[] {
  const vectorFieldName = schema.vector.fieldName ?? 'embedding';

  validateDims(schema.vector.dims);
  validateFieldNames(schema.fields, vectorFieldName);
  validateTextFieldCapabilities(schema.fields, capabilities);
  validateFlatHnswParams(
    schema.vector.algorithm,
    schema.vector.m,
    schema.vector.efConstruction,
    schema.vector.efRuntime,
  );

  const fieldArgs: string[] = [];
  for (const [fieldName, spec] of Object.entries(schema.fields)) {
    for (const token of buildFieldArgs(fieldName, spec)) {
      fieldArgs.push(token);
    }
  }

  const vectorArgs = buildVectorArgs(schema);

  return [
    `${name}:idx`,
    'ON',
    'HASH',
    'PREFIX',
    '1',
    `${name}:`,
    'SCHEMA',
    ...fieldArgs,
    ...vectorArgs,
  ];
}
