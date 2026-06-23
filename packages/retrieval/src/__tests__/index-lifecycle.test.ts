import { describe, it, expect, vi } from 'vitest';
import { Retriever } from '../retriever';
import { buildFtCreateArgs } from '../ft-create';
import type { RetrievalSchema } from '../schema';

const schema: RetrievalSchema = {
  fields: { source: { type: 'tag' } },
  vector: { metric: 'cosine', algorithm: 'hnsw', dims: 8 },
};

function indexNotFoundError(): Error {
  return new Error("Unknown index name 'docs:idx'");
}

describe('Retriever index lifecycle', () => {
  describe('createIndex', () => {
    it('issues FT.CREATE when the index does not exist', async () => {
      const call = vi.fn(async (command: string) => {
        if (command === 'FT.INFO') {
          throw indexNotFoundError();
        }
        return 'OK';
      });
      const retriever = new Retriever({ client: { call }, name: 'docs', schema });

      await retriever.createIndex();

      expect(call).toHaveBeenCalledWith('FT.INFO', 'docs:idx');
      expect(call).toHaveBeenCalledWith('FT.CREATE', ...buildFtCreateArgs('docs', schema));
    });

    it('does not issue FT.CREATE when the index already exists', async () => {
      const call = vi.fn(async (command: string) => {
        if (command === 'FT.INFO') {
          return ['index_name', 'docs:idx', 'num_docs', '0'];
        }
        return 'OK';
      });
      const retriever = new Retriever({ client: { call }, name: 'docs', schema });

      await retriever.createIndex();

      const createCalls = call.mock.calls.filter((args) => args[0] === 'FT.CREATE');
      expect(createCalls).toHaveLength(0);
    });

    it('rethrows when FT.INFO fails with a non-index error', async () => {
      const boom = new Error('LOADING Valkey is loading the dataset in memory');
      const call = vi.fn(async (command: string) => {
        if (command === 'FT.INFO') {
          throw boom;
        }
        return 'OK';
      });
      const retriever = new Retriever({ client: { call }, name: 'docs', schema });

      await expect(retriever.createIndex()).rejects.toThrow(boom);

      const createCalls = call.mock.calls.filter((args) => args[0] === 'FT.CREATE');
      expect(createCalls).toHaveLength(0);
    });

    it('tolerates a concurrent creation racing the FT.INFO probe', async () => {
      // FT.INFO says not-found, but a racing worker creates the index before our
      // FT.CREATE, which then throws "Index already exists" — must be swallowed.
      const call = vi.fn(async (command: string) => {
        if (command === 'FT.INFO') {
          throw indexNotFoundError();
        }
        if (command === 'FT.CREATE') {
          throw new Error('Index already exists');
        }
        return 'OK';
      });
      const retriever = new Retriever({ client: { call }, name: 'docs', schema });

      await expect(retriever.createIndex()).resolves.toBeUndefined();

      const createCalls = call.mock.calls.filter((args) => args[0] === 'FT.CREATE');
      expect(createCalls).toHaveLength(1);
    });

    it('rethrows when FT.CREATE fails with a non-already-exists error', async () => {
      const boom = new Error("OOM command not allowed when used memory > 'maxmemory'");
      const call = vi.fn(async (command: string) => {
        if (command === 'FT.INFO') {
          throw indexNotFoundError();
        }
        if (command === 'FT.CREATE') {
          throw boom;
        }
        return 'OK';
      });
      const retriever = new Retriever({ client: { call }, name: 'docs', schema });

      await expect(retriever.createIndex()).rejects.toThrow(boom);
    });
  });

  describe('dropIndex', () => {
    it('issues FT.DROPINDEX for the resolved index name', async () => {
      const call = vi.fn(async () => 'OK');
      const retriever = new Retriever({ client: { call }, name: 'docs', schema });

      await retriever.dropIndex();

      expect(call).toHaveBeenCalledWith('FT.DROPINDEX', 'docs:idx');
    });

    it('tolerates a missing index', async () => {
      const call = vi.fn(async () => {
        throw indexNotFoundError();
      });
      const retriever = new Retriever({ client: { call }, name: 'docs', schema });

      await expect(retriever.dropIndex()).resolves.toBeUndefined();
    });

    it('rethrows non-index errors', async () => {
      const boom = new Error('READONLY You can not write against a read only replica');
      const call = vi.fn(async () => {
        throw boom;
      });
      const retriever = new Retriever({ client: { call }, name: 'docs', schema });

      await expect(retriever.dropIndex()).rejects.toThrow(boom);
    });
  });

  describe('describeIndex', () => {
    it('parses FT.INFO into a typed description', async () => {
      const info = [
        'index_name',
        'docs:idx',
        'num_docs',
        '42',
        'indexing',
        '0',
        'attributes',
        [['identifier', 'embedding', 'type', 'VECTOR', 'DIM', '8']],
      ];
      const call = vi.fn(async (command: string) => {
        if (command === 'FT.INFO') {
          return info;
        }
        return 'OK';
      });
      const retriever = new Retriever({ client: { call }, name: 'docs', schema });

      const description = await retriever.describeIndex();

      expect(call).toHaveBeenCalledWith('FT.INFO', 'docs:idx');
      expect(description).toEqual({
        name: 'docs',
        dims: 8,
        numDocs: 42,
        indexingState: '0',
      });
    });

    it('propagates the error when the index does not exist', async () => {
      const call = vi.fn(async () => {
        throw indexNotFoundError();
      });
      const retriever = new Retriever({ client: { call }, name: 'docs', schema });

      await expect(retriever.describeIndex()).rejects.toThrow(indexNotFoundError().message);
    });
  });
});
