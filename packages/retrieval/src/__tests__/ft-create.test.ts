import { describe, it, expect } from 'vitest';
import { buildFtCreateArgs, indexName, keyPrefix } from '../ft-create';
import type { RetrievalSchema, FtCapabilities, VectorSpec } from '../schema';

describe('buildFtCreateArgs', () => {
  describe('minimal schema: no fields, HNSW defaults', () => {
    it('emits the full argument vector with default HNSW params', () => {
      const schema: RetrievalSchema = {
        fields: {},
        vector: { metric: 'cosine', algorithm: 'hnsw', dims: 128 },
      };
      expect(buildFtCreateArgs('myidx', schema)).toEqual([
        'myidx:idx',
        'ON',
        'HASH',
        'PREFIX',
        '1',
        'myidx:',
        'SCHEMA',
        'embedding',
        'VECTOR',
        'HNSW',
        '12',
        'TYPE',
        'FLOAT32',
        'DIM',
        '128',
        'DISTANCE_METRIC',
        'COSINE',
        'M',
        '16',
        'EF_CONSTRUCTION',
        '200',
        'EF_RUNTIME',
        '10',
      ]);
    });
  });

  describe('all three field types', () => {
    it('emits text, tag with separator, numeric sortable, then vector', () => {
      const schema: RetrievalSchema = {
        fields: {
          title: { type: 'text' },
          category: { type: 'tag', separator: '|' },
          score: { type: 'numeric', sortable: true },
        },
        vector: { metric: 'l2', algorithm: 'hnsw', dims: 64 },
      };
      expect(buildFtCreateArgs('docs', schema)).toEqual([
        'docs:idx',
        'ON',
        'HASH',
        'PREFIX',
        '1',
        'docs:',
        'SCHEMA',
        'title',
        'TEXT',
        'category',
        'TAG',
        'SEPARATOR',
        '|',
        'score',
        'NUMERIC',
        'SORTABLE',
        'embedding',
        'VECTOR',
        'HNSW',
        '12',
        'TYPE',
        'FLOAT32',
        'DIM',
        '64',
        'DISTANCE_METRIC',
        'L2',
        'M',
        '16',
        'EF_CONSTRUCTION',
        '200',
        'EF_RUNTIME',
        '10',
      ]);
    });

    it('emits tag without separator correctly', () => {
      const schema: RetrievalSchema = {
        fields: {
          tag_field: { type: 'tag' },
        },
        vector: { metric: 'cosine', algorithm: 'hnsw', dims: 8 },
      };
      const args = buildFtCreateArgs('t', schema);
      const schemaIdx = args.indexOf('SCHEMA');
      expect(args.slice(schemaIdx + 1, schemaIdx + 3)).toEqual(['tag_field', 'TAG']);
      expect(args[schemaIdx + 3]).not.toBe('SEPARATOR');
    });

    it('emits numeric without sortable correctly', () => {
      const schema: RetrievalSchema = {
        fields: {
          count: { type: 'numeric' },
        },
        vector: { metric: 'cosine', algorithm: 'hnsw', dims: 8 },
      };
      const args = buildFtCreateArgs('t', schema);
      const schemaIdx = args.indexOf('SCHEMA');
      expect(args.slice(schemaIdx + 1, schemaIdx + 3)).toEqual(['count', 'NUMERIC']);
      expect(args[schemaIdx + 3]).not.toBe('SORTABLE');
    });
  });

  describe('HNSW overrides and custom vector fieldName', () => {
    it('uses overridden m, efConstruction, efRuntime and custom fieldName', () => {
      const schema: RetrievalSchema = {
        fields: {},
        vector: {
          metric: 'ip',
          algorithm: 'hnsw',
          dims: 256,
          fieldName: 'vec',
          m: 32,
          efConstruction: 400,
          efRuntime: 50,
        },
      };
      expect(buildFtCreateArgs('custom', schema)).toEqual([
        'custom:idx',
        'ON',
        'HASH',
        'PREFIX',
        '1',
        'custom:',
        'SCHEMA',
        'vec',
        'VECTOR',
        'HNSW',
        '12',
        'TYPE',
        'FLOAT32',
        'DIM',
        '256',
        'DISTANCE_METRIC',
        'IP',
        'M',
        '32',
        'EF_CONSTRUCTION',
        '400',
        'EF_RUNTIME',
        '50',
      ]);
    });
  });

  describe('FLAT algorithm', () => {
    it('emits FLAT vector with 3 pairs (paramCount 6)', () => {
      const schema: RetrievalSchema = {
        fields: {},
        vector: { metric: 'cosine', algorithm: 'flat', dims: 32 },
      };
      expect(buildFtCreateArgs('flatidx', schema)).toEqual([
        'flatidx:idx',
        'ON',
        'HASH',
        'PREFIX',
        '1',
        'flatidx:',
        'SCHEMA',
        'embedding',
        'VECTOR',
        'FLAT',
        '6',
        'TYPE',
        'FLOAT32',
        'DIM',
        '32',
        'DISTANCE_METRIC',
        'COSINE',
      ]);
    });

    it('throws when m is set on a flat algorithm', () => {
      const schema: RetrievalSchema = {
        fields: {},
        vector: { metric: 'cosine', algorithm: 'flat', dims: 32 } as VectorSpec,
      };
      (schema.vector as Record<string, unknown>)['m'] = 16;
      expect(() => {
        buildFtCreateArgs('bad', schema);
      }).toThrow();
    });

    it('throws when efConstruction is set on a flat algorithm', () => {
      const schema: RetrievalSchema = {
        fields: {},
        vector: { metric: 'cosine', algorithm: 'flat', dims: 32 } as VectorSpec,
      };
      (schema.vector as Record<string, unknown>)['efConstruction'] = 200;
      expect(() => {
        buildFtCreateArgs('bad', schema);
      }).toThrow();
    });

    it('throws when efRuntime is set on a flat algorithm', () => {
      const schema: RetrievalSchema = {
        fields: {},
        vector: { metric: 'cosine', algorithm: 'flat', dims: 32 } as VectorSpec,
      };
      (schema.vector as Record<string, unknown>)['efRuntime'] = 10;
      expect(() => {
        buildFtCreateArgs('bad', schema);
      }).toThrow();
    });

    it('throws when dims is missing on flat algorithm', () => {
      const schema: RetrievalSchema = {
        fields: {},
        vector: { metric: 'cosine', algorithm: 'flat' },
      };
      expect(() => {
        buildFtCreateArgs('bad', schema);
      }).toThrow(/dims must be a positive integer/);
    });

    it('throws when dims is invalid on flat algorithm', () => {
      const schema: RetrievalSchema = {
        fields: {},
        vector: { metric: 'cosine', algorithm: 'flat', dims: -5 },
      };
      expect(() => {
        buildFtCreateArgs('bad', schema);
      }).toThrow(/dims must be a positive integer/);
    });
  });

  describe('metric mapping', () => {
    const cases: Array<[RetrievalSchema['vector']['metric'], string]> = [
      ['cosine', 'COSINE'],
      ['l2', 'L2'],
      ['ip', 'IP'],
    ];

    for (const [metric, expected] of cases) {
      it(`maps ${metric} to ${expected}`, () => {
        const schema: RetrievalSchema = {
          fields: {},
          vector: { metric, algorithm: 'hnsw', dims: 4 },
        };
        const args = buildFtCreateArgs('m', schema);
        const metricIdx = args.indexOf('DISTANCE_METRIC');
        expect(args[metricIdx + 1]).toBe(expected);
      });
    }
  });

  describe('textFields capability gating', () => {
    it('emits TEXT fields when capabilities is omitted', () => {
      const schema: RetrievalSchema = {
        fields: { body: { type: 'text' } },
        vector: { metric: 'cosine', algorithm: 'hnsw', dims: 4 },
      };
      const args = buildFtCreateArgs('n', schema);
      expect(args).toContain('TEXT');
    });

    it('emits TEXT fields when textFields is true', () => {
      const schema: RetrievalSchema = {
        fields: { body: { type: 'text' } },
        vector: { metric: 'cosine', algorithm: 'hnsw', dims: 4 },
      };
      const caps: FtCapabilities = { textFields: true };
      const args = buildFtCreateArgs('n', schema, caps);
      expect(args).toContain('TEXT');
    });

    it('throws when textFields is false and schema has text fields, message contains field names', () => {
      const schema: RetrievalSchema = {
        fields: {
          title: { type: 'text' },
          body: { type: 'text' },
        },
        vector: { metric: 'cosine', algorithm: 'hnsw', dims: 4 },
      };
      const caps: FtCapabilities = { textFields: false };
      expect(() => {
        buildFtCreateArgs('n', schema, caps);
      }).toThrowError(/title/);
    });

    it('error from textFields:false contains all offending field names', () => {
      const schema: RetrievalSchema = {
        fields: {
          title: { type: 'text' },
          body: { type: 'text' },
        },
        vector: { metric: 'cosine', algorithm: 'hnsw', dims: 4 },
      };
      const caps: FtCapabilities = { textFields: false };
      expect(() => {
        buildFtCreateArgs('n', schema, caps);
      }).toThrowError(/body/);
    });

    it('does NOT throw when textFields is false and schema has no text fields', () => {
      const schema: RetrievalSchema = {
        fields: { category: { type: 'tag' } },
        vector: { metric: 'cosine', algorithm: 'hnsw', dims: 4 },
      };
      const caps: FtCapabilities = { textFields: false };
      expect(() => {
        buildFtCreateArgs('n', schema, caps);
      }).not.toThrow();
    });
  });

  describe('dims validation', () => {
    it('throws when dims is missing', () => {
      const schema: RetrievalSchema = {
        fields: {},
        vector: { metric: 'cosine', algorithm: 'hnsw' },
      };
      expect(() => {
        buildFtCreateArgs('n', schema);
      }).toThrow(/dims must be a positive integer/);
    });

    it('throws when dims is zero', () => {
      const schema: RetrievalSchema = {
        fields: {},
        vector: { metric: 'cosine', algorithm: 'hnsw', dims: 0 },
      };
      expect(() => {
        buildFtCreateArgs('n', schema);
      }).toThrow(/dims must be a positive integer/);
    });

    it('throws when dims is negative', () => {
      const schema: RetrievalSchema = {
        fields: {},
        vector: { metric: 'cosine', algorithm: 'hnsw', dims: -1 },
      };
      expect(() => {
        buildFtCreateArgs('n', schema);
      }).toThrow(/dims must be a positive integer/);
    });

    it('throws when dims is a non-integer', () => {
      const schema: RetrievalSchema = {
        fields: {},
        vector: { metric: 'cosine', algorithm: 'hnsw', dims: 1.5 },
      };
      expect(() => {
        buildFtCreateArgs('n', schema);
      }).toThrow(/dims must be a positive integer/);
    });
  });

  describe('field name validation', () => {
    it('throws when a field name is empty', () => {
      const schema: RetrievalSchema = {
        fields: { '': { type: 'tag' } },
        vector: { metric: 'cosine', algorithm: 'hnsw', dims: 4 },
      };
      expect(() => {
        buildFtCreateArgs('n', schema);
      }).toThrow();
    });

    it('throws when a field name collides with the default vector field name', () => {
      const schema: RetrievalSchema = {
        fields: { embedding: { type: 'tag' } },
        vector: { metric: 'cosine', algorithm: 'hnsw', dims: 4 },
      };
      expect(() => {
        buildFtCreateArgs('n', schema);
      }).toThrow(/embedding/);
    });

    it('throws when a field name collides with a custom vector fieldName', () => {
      const schema: RetrievalSchema = {
        fields: { vec: { type: 'tag' } },
        vector: { metric: 'cosine', algorithm: 'hnsw', dims: 4, fieldName: 'vec' },
      };
      expect(() => {
        buildFtCreateArgs('n', schema);
      }).toThrow(/vec/);
    });
  });

  describe('index name validation', () => {
    it('throws when index name is empty', () => {
      const schema: RetrievalSchema = {
        fields: {},
        vector: { metric: 'cosine', algorithm: 'hnsw', dims: 4 },
      };
      expect(() => {
        buildFtCreateArgs('', schema);
      }).toThrow(/Index name must not be empty/);
    });

    it('throws when index name is whitespace-only', () => {
      const schema: RetrievalSchema = {
        fields: {},
        vector: { metric: 'cosine', algorithm: 'hnsw', dims: 4 },
      };
      expect(() => {
        buildFtCreateArgs('   ', schema);
      }).toThrow(/Index name must not be empty/);
    });
  });
});

describe('indexName', () => {
  it('returns name:idx for a valid name', () => {
    expect(indexName('docs')).toBe('docs:idx');
  });

  it('throws on empty name', () => {
    expect(() => indexName('')).toThrow(/Index name must not be empty/);
  });
});

describe('keyPrefix', () => {
  it('returns name: for a valid name', () => {
    expect(keyPrefix('docs')).toBe('docs:');
  });

  it('throws on empty name', () => {
    expect(() => keyPrefix('')).toThrow(/Index name must not be empty/);
  });
});
