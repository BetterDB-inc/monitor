import {
  toMap,
  parseVectorIndexInfo,
  parseAttributeField,
  parseGcStats,
  parseIndexDefinition,
  parseVectorSearchResponse,
  sanitizeFilter,
} from './vector-index.parser';

// ---------------------------------------------------------------------------
// toMap
// ---------------------------------------------------------------------------
describe('toMap', () => {
  it('should parse flat key-value array into a Map', () => {
    const m = toMap(['a', 1, 'b', 'two']);
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toBe('two');
    expect(m.size).toBe(2);
  });

  it('should handle empty array', () => {
    expect(toMap([]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sanitizeFilter
// ---------------------------------------------------------------------------
describe('sanitizeFilter', () => {
  it('should return trimmed filter for valid input', () => {
    expect(sanitizeFilter('  @tag:{val}  ')).toBe('@tag:{val}');
  });

  it('should return undefined for empty/whitespace', () => {
    expect(sanitizeFilter('')).toBeUndefined();
    expect(sanitizeFilter('   ')).toBeUndefined();
    expect(sanitizeFilter(undefined)).toBeUndefined();
  });

  it('should throw on control characters', () => {
    expect(() => sanitizeFilter('abc\x00def')).toThrow('Invalid filter');
  });

  it('should throw on => operator', () => {
    expect(() => sanitizeFilter('@f:{x}=>{ $y}')).toThrow('Invalid filter');
  });

  it('should throw on input exceeding 1024 chars', () => {
    expect(() => sanitizeFilter('a'.repeat(1025))).toThrow('Invalid filter');
  });

  it('should accept exactly 1024 char filter', () => {
    expect(sanitizeFilter('a'.repeat(1024))).toBe('a'.repeat(1024));
  });
});

// ---------------------------------------------------------------------------
// parseVectorIndexInfo
// ---------------------------------------------------------------------------
describe('parseVectorIndexInfo', () => {
  // A minimal Valkey Search style FT.INFO response
  const valkeyResponse: unknown[] = [
    'num_docs', 100,
    'num_records', 200,
    'hash_indexing_failures', 0,
    'backfill_complete_percent', 0.75,
    'state', 'backfilling',
    'attributes', [
      ['identifier', 'embedding', 'type', 'VECTOR', 'index', [
        'dimensions', 128,
        'distance_metric', 'COSINE',
        'algorithm', ['name', 'HNSW', 'm', 16, 'ef_construction', 200],
      ]],
      ['identifier', 'title', 'type', 'TEXT'],
    ],
    'index_definition', ['prefixes', ['doc:'], 'default_language', 'english', 'default_score', 1],
  ];

  it('should parse Valkey Search response', () => {
    const info = parseVectorIndexInfo('my-idx', valkeyResponse);

    expect(info.name).toBe('my-idx');
    expect(info.numDocs).toBe(100);
    expect(info.numRecords).toBe(200);
    expect(info.indexingFailures).toBe(0);
    expect(info.percentIndexed).toBe(75);
    expect(info.indexingState).toBe('indexing');
    expect(info.fields).toHaveLength(2);
    expect(info.numVectorFields).toBe(1);
  });

  it('should parse vector field attributes from Valkey Search nested format', () => {
    const info = parseVectorIndexInfo('idx', valkeyResponse);
    const vecField = info.fields[0];

    expect(vecField.name).toBe('embedding');
    expect(vecField.type).toBe('VECTOR');
    expect(vecField.dimension).toBe(128);
    expect(vecField.distanceMetric).toBe('COSINE');
    expect(vecField.algorithm).toBe('HNSW');
    expect(vecField.hnswM).toBe(16);
    expect(vecField.hnswEfConstruction).toBe(200);
  });

  it('should parse RediSearch style response', () => {
    const redisResponse: unknown[] = [
      'num_docs', 50,
      'num_records', 50,
      'hash_indexing_failures', 2,
      'percent_indexed', 0.5,
      'indexing', 1,
      'vector_index_sz_mb', 12.5,
      'attributes', [
        ['identifier', 'vec', 'type', 'VECTOR', 'algorithm', 'FLAT', 'DIM', 64, 'DISTANCE_METRIC', 'L2'],
      ],
      'gc_stats', ['gc_stats_cycles', 5, 'bytes_collected', 1024, 'total_ms_run', 10],
      'index_definition', ['prefixes', ['item:']],
    ];

    const info = parseVectorIndexInfo('redis-idx', redisResponse);

    expect(info.percentIndexed).toBe(50);
    expect(info.indexingState).toBe('indexing');
    expect(info.memorySizeMb).toBe(12.5);
    expect(info.gcStats).toEqual({ gcCycles: 5, bytesCollected: 1024, totalMsRun: 10 });
    expect(info.indexDefinition?.prefixes).toEqual(['item:']);

    const vecField = info.fields[0];
    expect(vecField.algorithm).toBe('FLAT');
    expect(vecField.dimension).toBe(64);
    expect(vecField.distanceMetric).toBe('L2');
  });

  it('should handle fully indexed state (ready)', () => {
    const info = parseVectorIndexInfo('idx', [
      'num_docs', 10, 'num_records', 10, 'hash_indexing_failures', 0,
      'backfill_complete_percent', 1.0, 'state', 'ready', 'attributes', [],
    ]);

    expect(info.percentIndexed).toBe(100);
    expect(info.indexingState).toBe('indexed');
  });

  it('should handle RediSearch indexed state (indexing=0)', () => {
    const info = parseVectorIndexInfo('idx', [
      'num_docs', 10, 'num_records', 10, 'hash_indexing_failures', 0,
      'percent_indexed', 1.0, 'indexing', 0, 'attributes', [],
    ]);

    expect(info.percentIndexed).toBe(100);
    expect(info.indexingState).toBe('indexed');
  });

  it('should handle percentIndexed > 1 (already in 0-100 range)', () => {
    const info = parseVectorIndexInfo('idx', [
      'num_docs', 10, 'num_records', 10, 'hash_indexing_failures', 0,
      'backfill_complete_percent', 75, 'state', 'backfilling', 'attributes', [],
    ]);

    expect(info.percentIndexed).toBe(75);
  });

  it('should clamp percentIndexed > 100 to 100', () => {
    const info = parseVectorIndexInfo('idx', [
      'num_docs', 10, 'num_records', 10, 'hash_indexing_failures', 0,
      'backfill_complete_percent', 150, 'state', 'backfilling', 'attributes', [],
    ]);

    expect(info.percentIndexed).toBe(100);
  });

  it('should fall back to summed memory sizes when vector_index_sz_mb is 0', () => {
    const info = parseVectorIndexInfo('idx', [
      'num_docs', 10, 'num_records', 10, 'hash_indexing_failures', 0,
      'percent_indexed', 1.0, 'indexing', 0, 'attributes', [],
      'inverted_sz_mb', 1.5, 'offset_vectors_sz_mb', 0.5,
      'doc_table_size_mb', 0.3, 'key_table_size_mb', 0.2,
    ]);

    expect(info.memorySizeMb).toBe(2.5);
  });

  it('should return 0 memory when no size fields are present', () => {
    const info = parseVectorIndexInfo('idx', [
      'num_docs', 0, 'num_records', 0, 'hash_indexing_failures', 0,
      'percent_indexed', 0, 'indexing', 0, 'attributes', [],
    ]);

    expect(info.memorySizeMb).toBe(0);
  });

  it('should handle missing attributes gracefully', () => {
    const info = parseVectorIndexInfo('idx', [
      'num_docs', 0, 'num_records', 0, 'hash_indexing_failures', 0,
      'percent_indexed', 1, 'indexing', 0,
    ]);

    expect(info.fields).toEqual([]);
    expect(info.gcStats).toBeNull();
    expect(info.indexDefinition).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseAttributeField
// ---------------------------------------------------------------------------
describe('parseAttributeField', () => {
  it('should parse a TEXT field', () => {
    const field = parseAttributeField(['identifier', 'title', 'type', 'TEXT', 'WEIGHT', 2.0, 'SORTABLE', true]);

    expect(field.name).toBe('title');
    expect(field.type).toBe('TEXT');
    expect(field.weight).toBe(2.0);
    expect(field.sortable).toBe(true);
  });

  it('should parse a TAG field', () => {
    const field = parseAttributeField(['identifier', 'category', 'type', 'TAG', 'SEPARATOR', ';', 'CASESENSITIVE', true]);

    expect(field.name).toBe('category');
    expect(field.type).toBe('TAG');
    expect(field.separator).toBe(';');
    expect(field.caseSensitive).toBe(true);
  });

  it('should parse a NUMERIC field', () => {
    const field = parseAttributeField(['identifier', 'price', 'type', 'NUMERIC', 'SORTABLE', true]);

    expect(field.name).toBe('price');
    expect(field.type).toBe('NUMERIC');
    expect(field.sortable).toBe(true);
  });

  it('should parse RediSearch VECTOR field with flat attributes', () => {
    const field = parseAttributeField([
      'identifier', 'vec', 'type', 'VECTOR',
      'algorithm', 'HNSW', 'DIM', 256, 'DISTANCE_METRIC', 'IP',
      'M', 32, 'EF_CONSTRUCTION', 400, 'EF_RUNTIME', 100,
    ]);

    expect(field.type).toBe('VECTOR');
    expect(field.algorithm).toBe('HNSW');
    expect(field.dimension).toBe(256);
    expect(field.distanceMetric).toBe('IP');
    expect(field.hnswM).toBe(32);
    expect(field.hnswEfConstruction).toBe(400);
    expect(field.hnswEfRuntime).toBe(100);
  });

  it('should parse Valkey Search VECTOR field with nested index data', () => {
    const field = parseAttributeField([
      'identifier', 'emb', 'type', 'VECTOR',
      'index', [
        'dimensions', 768,
        'distance_metric', 'COSINE',
        'algorithm', ['name', 'HNSW', 'm', 16, 'ef_construction', 200, 'ef_runtime', 50],
      ],
    ]);

    expect(field.type).toBe('VECTOR');
    expect(field.dimension).toBe(768);
    expect(field.distanceMetric).toBe('COSINE');
    expect(field.algorithm).toBe('HNSW');
    expect(field.hnswM).toBe(16);
    expect(field.hnswEfConstruction).toBe(200);
    expect(field.hnswEfRuntime).toBe(50);
  });

  it('should handle VECTOR field with string algorithm in Valkey format', () => {
    const field = parseAttributeField([
      'identifier', 'vec', 'type', 'VECTOR',
      'index', ['dimensions', 64, 'distance_metric', 'L2', 'algorithm', 'FLAT'],
    ]);

    expect(field.algorithm).toBe('FLAT');
    expect(field.dimension).toBe(64);
    expect(field.hnswM).toBeNull();
  });

  it('should fall back to attribute name when identifier is missing', () => {
    const field = parseAttributeField(['attribute', 'myfield', 'type', 'TEXT']);
    expect(field.name).toBe('myfield');
  });

  it('should return nulls for missing optional vector fields', () => {
    const field = parseAttributeField(['identifier', 'simple', 'type', 'TEXT']);

    expect(field.algorithm).toBeNull();
    expect(field.dimension).toBeNull();
    expect(field.distanceMetric).toBeNull();
    expect(field.hnswM).toBeNull();
    expect(field.separator).toBeNull();
    expect(field.weight).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseGcStats
// ---------------------------------------------------------------------------
describe('parseGcStats', () => {
  it('should parse gc stats array', () => {
    const stats = parseGcStats(['gc_stats_cycles', 10, 'bytes_collected', 2048, 'total_ms_run', 5]);

    expect(stats).toEqual({ gcCycles: 10, bytesCollected: 2048, totalMsRun: 5 });
  });

  it('should return null for non-array input', () => {
    expect(parseGcStats(null)).toBeNull();
    expect(parseGcStats(undefined)).toBeNull();
    expect(parseGcStats('string')).toBeNull();
  });

  it('should default missing values to 0', () => {
    const stats = parseGcStats([]);
    expect(stats).toEqual({ gcCycles: 0, bytesCollected: 0, totalMsRun: 0 });
  });
});

// ---------------------------------------------------------------------------
// parseIndexDefinition
// ---------------------------------------------------------------------------
describe('parseIndexDefinition', () => {
  it('should parse index definition with prefixes', () => {
    const def = parseIndexDefinition(['prefixes', ['doc:', 'item:'], 'default_language', 'english', 'default_score', 1]);

    expect(def?.prefixes).toEqual(['doc:', 'item:']);
    expect(def?.defaultLanguage).toBe('english');
    expect(def?.defaultScore).toBe(1);
  });

  it('should return null for non-array input', () => {
    expect(parseIndexDefinition(null)).toBeNull();
    expect(parseIndexDefinition(undefined)).toBeNull();
  });

  it('should handle missing optional fields', () => {
    const def = parseIndexDefinition(['prefixes', ['test:']]);

    expect(def?.prefixes).toEqual(['test:']);
    expect(def?.defaultLanguage).toBeNull();
    expect(def?.defaultScore).toBeNull();
  });

  it('should handle missing prefixes', () => {
    const def = parseIndexDefinition([]);
    expect(def?.prefixes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseVectorSearchResponse
// ---------------------------------------------------------------------------
describe('parseVectorSearchResponse', () => {
  it('should parse FT.SEARCH response with score and fields', () => {
    const raw = [
      2,                          // total count
      'key:1', ['title', 'Hello', '__vec_score', '0.5', 'tag', 'a'],
      'key:2', ['title', 'World', '__vec_score', '0.8'],
    ];

    const results = parseVectorSearchResponse(raw, 'vec');

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ key: 'key:1', score: 0.5, fields: { title: 'Hello', tag: 'a' } });
    expect(results[1]).toEqual({ key: 'key:2', score: 0.8, fields: { title: 'World' } });
  });

  it('should exclude the vector field itself from returned fields', () => {
    const raw = [1, 'k1', ['vec', '<binary>', '__vec_score', '0.1', 'name', 'test']];
    const results = parseVectorSearchResponse(raw, 'vec');

    expect(results[0].fields).toEqual({ name: 'test' });
    expect(results[0].fields).not.toHaveProperty('vec');
  });

  it('should handle empty results', () => {
    const results = parseVectorSearchResponse([0], 'vec');
    expect(results).toEqual([]);
  });

  it('should skip non-array field entries', () => {
    const raw = [1, 'k1', 'not-an-array'];
    const results = parseVectorSearchResponse(raw, 'vec');
    expect(results).toEqual([]);
  });

  it('should default score to 0 when score field is missing', () => {
    const raw = [1, 'k1', ['name', 'test']];
    const results = parseVectorSearchResponse(raw, 'vec');

    expect(results[0].score).toBe(0);
  });
});
